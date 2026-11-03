# Deploying tlcmap-mcp to staging

The server runs as a systemd service bound to `127.0.0.1:3100`, behind Apache at
`https://test-mcp.tlcmap.org`, and reads from production `https://tlcmap.org`. The host is Ubuntu
22.04 and also serves the staging TLCMap app.

## One-time setup

### 1. DNS

Create an A record for `test-mcp.tlcmap.org` pointing at the staging host. Confirm it resolves
before requesting a certificate.

### 2. Node 24

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # must print v24.*
command -v node     # must print /usr/bin/node
```

The unit file runs `/usr/bin/node`; if the path differs, stop and fix it before continuing.

### 3. Deploy key and repository checkout

Root clones the repository, so root needs read access to it first. Every later step uses the
checkout at `/root/tlcmap-mcp-deploy`.

```bash
sudo install -d -m 700 /root/.ssh
sudo ssh-keygen -t ed25519 -f /root/.ssh/tlcmap-mcp-deploy -N '' -C 'tlcmap-mcp deploy'
sudo cat /root/.ssh/tlcmap-mcp-deploy.pub
```

Add the public key as a read-only deploy key on `Systemik-Solutions/tlcmap-mcp` in GitHub, then
tell SSH to use it:

```bash
sudo tee -a /root/.ssh/config >/dev/null <<'CONF'
Host github.com
    IdentityFile /root/.ssh/tlcmap-mcp-deploy
    IdentitiesOnly yes
CONF
sudo chmod 600 /root/.ssh/config
sudo ssh -T git@github.com    # accept the host key; "successfully authenticated" is expected
sudo git clone git@github.com:Systemik-Solutions/tlcmap-mcp.git /root/tlcmap-mcp-deploy
```

If root already uses another key for `github.com`, give this one its own host alias instead and
adjust `REPO` in `deploy.sh`. To refresh the checkout later: `sudo git -C /root/tlcmap-mcp-deploy pull`.

### 4. Service user, directories and environment file

```bash
sudo useradd --system --home /opt/tlcmap-mcp --shell /usr/sbin/nologin tlcmap-mcp
sudo mkdir -p /opt/tlcmap-mcp/releases /etc/tlcmap-mcp
sudo chown -R tlcmap-mcp:tlcmap-mcp /opt/tlcmap-mcp
sudo install -o root -g tlcmap-mcp -m 0640 /root/tlcmap-mcp-deploy/deploy/env.example /etc/tlcmap-mcp/env
```

Edit `/etc/tlcmap-mcp/env` if any value differs from staging. `PUBLIC_URL` must match the vhost
`ServerName` (see "Host and Origin checks" below).

### 5. Confirm port 3100 is free

```bash
ss -ltnp | grep 3100
```

This must print nothing. If it prints a listener, choose another port, set `PORT` in the env file
and change the port in the vhost.

### 6. Install the unit

```bash
sudo cp /root/tlcmap-mcp-deploy/deploy/tlcmap-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tlcmap-mcp
```

Do not start it yet; there is no release until the first deploy.

### 7. Apache and certificate

This host also serves the staging TLCMap app, so a mistake here can take that site down. Follow the
order exactly.

```bash
sudo apt install -y certbot python3-certbot-apache   # or confirm they are already installed for the other site
sudo apachectl -S
```

Confirm in the `apachectl -S` output that the existing sites use name-based vhosts on `*:80` and
`*:443`. If they use specific addresses, adapt the new vhosts to match before going on.

```bash
sudo a2enmod proxy proxy_http headers ssl
sudo cp /root/tlcmap-mcp-deploy/deploy/test-mcp.tlcmap.org.conf /etc/apache2/sites-available/
sudo a2ensite test-mcp.tlcmap.org
sudo apachectl configtest      # must print Syntax OK
sudo systemctl reload apache2  # only the *:80 vhost is active now
sudo certbot certonly --apache -d test-mcp.tlcmap.org
sudo apachectl configtest
sudo systemctl reload apache2  # the *:443 vhost is now read
curl -sI https://test-mcp.tlcmap.org/healthz
```

The `*:443` vhost is wrapped in `<IfFile>` on the certificate path, so it is ignored until
`certbot certonly` has created the certificate. Do not use `certbot --apache` (without `certonly`):
the vhost already carries its own certificate lines. Until the first deploy completes the `curl`
returns 502 from Apache, which proves TLS and the proxy are in place.

The vhost proxies with `flushpackets=on` and disables compression for `/mcp`. Some 2025-era MCP
clients receive single-event SSE replies even though the server is in JSON mode, and buffering or
gzip would hold those replies back.

### 8. First deploy

```bash
sudo /root/tlcmap-mcp-deploy/deploy/deploy.sh main
```

Expect progress lines ending with `Deployed <sha>`. Then check
`curl -s https://test-mcp.tlcmap.org/healthz`.

## Runbook

### Deploy

```bash
sudo /root/tlcmap-mcp-deploy/deploy/deploy.sh <git-ref>     # a branch, tag or commit
```

The script clones the ref into `/opt/tlcmap-mcp/releases/<sha>`, runs `npm ci`, `npm run build`
and `npm prune --omit=dev` as `tlcmap-mcp`, switches `current`, restarts the service and waits up
to 30 seconds for `/healthz` to report the release's `package.json` version. If the build or the
health check fails it deletes the failed release, restores the previous release and restarts (on a
first deploy it removes `current` and stops the service instead), and exits 1. On success it keeps
the three newest releases (and always the one `current` points to) and deletes the rest. It reads
`PORT` from `/etc/tlcmap-mcp/env` and defaults to 3100.

### Roll back

```bash
sudo /root/tlcmap-mcp-deploy/deploy/deploy.sh --rollback
```

Re-points `current` to the newest release directory other than the current one and restarts. Run
it again to switch back.

### Logs

```bash
journalctl -u tlcmap-mcp -f
```

Application logs are JSON lines. At startup the SDK also prints one plain-text warning beginning
`responseMode: 'json' drops mid-call notifications…`. This is expected: A0 has no mid-call
notifications.

### Health

```bash
curl -s https://test-mcp.tlcmap.org/healthz
```

Returns JSON including `version`, which must match the deployed release's `package.json`.

### Raising limits

Edit `/etc/tlcmap-mcp/env` (see the comments in `deploy/env.example` for each variable), then:

```bash
sudo systemctl restart tlcmap-mcp
```

The service refuses to start on an invalid value; the reason is in the journal. Memory is capped
by the unit (`--max-old-space-size=1024`, `MemoryMax=2G`), so size `CACHE_MAX_BYTES` accordingly.

### Host and Origin checks

- Host validation admits only the `PUBLIC_URL` hostname, `localhost` and `127.0.0.1`; any other
  `Host` gets 403. `PUBLIC_URL` must match the vhost `ServerName`, and the vhost keeps
  `ProxyPreserveHost On` so the original `Host` reaches the server.
- Origin validation is the SDK default. Requests with no `Origin` header (Claude Code and every
  non-browser client) pass. A browser request whose `Origin` is not localhost gets 403. This is
  intended; do not add an allow-list to work around it.

### External uptime check

Point an uptime monitor at `https://test-mcp.tlcmap.org/healthz`. Never point it at `/mcp`: that
endpoint expects MCP requests, is rate limited and would put probe traffic through the MCP path.
