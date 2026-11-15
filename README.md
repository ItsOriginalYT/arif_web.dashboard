# Arif WebDashboard

Self-hosted historical telemetry, simulated and authorized live telemetry, private chat, personal settings, and administration for ADAM-SERVER-1. One Node.js process serves the UI and API. SQLite stores accounts, chat attachments, configuration revisions, profiles, and the audit log.

Repository ID `arif_web.dashboard`. The dashboard uses HTML, CSS and JavaScript in the browser, Node.js for the server and automated tests, OpenF1 for telemetry, and optional Caddy for HTTPS.

## Start on Windows

1. Install 64-bit Node.js 24.11 or newer, copy this folder to a local drive on ADAM-SERVER-1, and open PowerShell in that folder. The app uses Node's built-in SQLite and needs no package install. [Node.js downloads](https://nodejs.org/en/download)
2. Run the bootstrap script and enter the temporary Administrator password from your specification at the hidden prompt. It creates one `Administrator` account, stores a salted scrypt hash, and requires password rotation at first sign-in. Run it once per database.
3. Start the app and open [the local dashboard](http://127.0.0.1:8765/) on the host. Sign in as `Administrator` and change the temporary password before opening LAN access. Create other accounts under **Administration → Users**.

~~~powershell
.\bootstrap.ps1
node server.mjs
~~~

If script execution is restricted, you can run the equivalent commands directly in PowerShell.

~~~powershell
$initial = Read-Host 'Temporary Administrator password' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($initial)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) | node server.mjs bootstrap }
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $initial.Dispose()
}
~~~

Start the app from the same directory as bootstrap, or set `ADAM_DATA` to the same absolute path for both commands. For unattended startup on Windows, use a dedicated low-privilege account and a startup task that runs `node server.mjs` with this folder as its working directory. Restrict the data directory and TLS key to the service account and backup operators.

For deployment settings, copy [the environment template](.env.example) to `.env` and start with `node --env-file=.env server.mjs`. For bootstrap with that file, pass the hidden prompt's output to `node --env-file=.env server.mjs bootstrap` so both commands use the same database.

## Network and transport

| Mode | Listener | Browser URL |
| --- | --- | --- |
| `local` (default) | Loopback HTTP on `127.0.0.1:8765` | `http://127.0.0.1:8765` |
| `tls` | Node serves HTTPS on the selected interface and port | `ADAM_PUBLIC_ORIGIN` |
| `proxy` | Loopback HTTP behind an HTTPS reverse proxy on the same machine | `ADAM_PUBLIC_ORIGIN` |

`ADAM_PORT` defaults to `8765` and `ADAM_HOST` defaults to `127.0.0.1`. In TLS or proxy mode, give `ADAM_PUBLIC_ORIGIN` the exact HTTPS URL origin the browser uses, with its nonstandard port if applicable and without a trailing slash. In **Administration → Configuration**, each service can inherit the server transport or require HTTPS. Browser chat uses HTTPS over TCP on the LAN and remotely, with short polling for new messages. OpenF1 requests use HTTPS from the server.

### LAN with direct HTTPS

Use a PEM certificate chain and private key for the DNS name or IP clients will use. Install the issuing CA on LAN clients if your certificate comes from a private CA. Point LAN DNS at ADAM-SERVER-1 and allow inbound TCP 8765 on the Windows Private network profile for the local subnet.

~~~powershell
$env:ADAM_TRANSPORT = 'tls'
$env:ADAM_HOST = '0.0.0.0'
$env:ADAM_PUBLIC_ORIGIN = 'https://adam-server-1:8765'
$env:ADAM_TLS_CERT = 'C:\Dashboard-TLS\fullchain.pem'
$env:ADAM_TLS_KEY = 'C:\Dashboard-TLS\privkey.pem'
node server.mjs
~~~

### LAN launcher for Windows

Put the official Windows 64-bit Caddy executable named `caddy.exe` alongside [the LAN launcher](Start-ArifWebDashboard-LAN.ps1), or give the launcher its location with `-CaddyPath`. The launcher pulls GitHub's `default` branch into `I:\IntendedUseStorage\Websites\ArifWebDashboard` and starts the dashboard at `https://192.168.100.63:8765/`. Pass `-LanAddress` if ADAM-SERVER-1 has a different IPv4 address. [Caddy installation](https://caddyserver.com/docs/install#static-binaries)

~~~powershell
.\Start-ArifWebDashboard-LAN.ps1
~~~

If the firewall blocks LAN access, run `.\Start-ArifWebDashboard-LAN.ps1 -ConfigureFirewall` once in Administrator PowerShell. It allows TCP 8765 from the local subnet on the Private network profile. Run the launcher normally afterward. On each client device, trust the public root certificate printed by the launcher before signing in. [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https)

### Caddy and Playit Premium

For an HTTPS reverse proxy, start Node in `proxy` mode behind Caddy. Caddy preserves the original host and sets the forwarded HTTPS protocol. Keep the Node port on loopback and route Playit to Caddy. Playit's HTTPS tunnel requires Premium and terminates TLS on your server through Caddy. Create the tunnel using the Playit guide, then substitute your chosen hostname in [the Caddy template](Caddyfile.example). [Playit HTTPS tunnel setup](https://playit.gg/support/https-tunnel/) · [Caddy reverse proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

~~~powershell
$env:ADAM_TRANSPORT = 'proxy'
$env:ADAM_HOST = '127.0.0.1'
$env:ADAM_PUBLIC_ORIGIN = 'https://your-dashboard.playit.plus'
node server.mjs
~~~

~~~caddyfile
your-dashboard.playit.plus {
    reverse_proxy 127.0.0.1:8765
}
~~~

This app uses one canonical origin per instance. Open the same HTTPS hostname on the LAN and remotely once the tunnel is active. For a LAN-only Caddy deployment, use your LAN hostname in both places and add `tls internal` to the Caddy block. Trust Caddy's local CA on the LAN clients. [Caddy TLS options](https://caddyserver.com/docs/caddyfile/directives/tls)

## Telemetry

**Historical** uses the free OpenF1 archive from 2023 onward. Choose a completed session, driver and lap, load telemetry, then play or seek at 0.5×, 1×, 2× or 4×. Choose **All Drivers** to compare traces and readings at the same elapsed time from each driver's selected lap start. Choose **All Laps** to replay on the shared session clock. Full-session replay keeps roughly one sample per second per driver and can take a few minutes to load within OpenF1's free request limits. For sessions lacking usable lap times, the dashboard offers the opening two-minute window. [OpenF1 API reference](https://openf1.org/docs/)

**Live** starts in clearly labeled simulation mode. To enable real data, obtain authorized OpenF1 Sponsor access and provide the provider credentials in the environment of the service account. For an interactive Windows run, enter the credentials at the prompts below. For an unattended run, inject both values from your service account's secret store.

~~~powershell
$env:OPENF1_USERNAME = Read-Host 'OpenF1 username'
$providerPassword = Read-Host 'OpenF1 password' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($providerPassword)
try {
    $env:OPENF1_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    node server.mjs
}
finally {
    Remove-Item Env:OPENF1_PASSWORD, Env:OPENF1_USERNAME -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $providerPassword.Dispose()
}
~~~

In **Administration → Configuration**, select **Authorized OpenF1**, test the draft and apply it when ready. The server exchanges the account credentials for a token and uses authenticated REST polling. The live page shows waiting or unavailable when no fresh samples arrive. During the next authorized race, verify that the correct session and drivers appear, timestamps advance, and switching driver updates the trace.

OpenF1 describes its community and Sponsor tiers as personal-use access, intended for education, research and non-commercial fan engagement. Contact OpenF1 about licensing before public redistribution, commercial use, or another use outside those terms, and obtain any applicable rights. OpenF1 is independent of Formula 1. [OpenF1 access and usage terms](https://openf1.org/) · [Provider authentication](https://openf1.org/auth.html)

## Administration and private chat

**Save draft** stages edits. **TEST** previews the saved settings in the initiating browser session for 15 seconds by default, with an early stop button. The server checks the deadline on each request. **APPLY** asks for two separate confirmations tied to the draft revision and publishes a new immutable version for everyone. **REVERT** copies the active version to the draft. **REWIND** makes the parent version active while retaining the full version records. **RESET** asks twice, then copies the configured defaults into the draft.

The console runs application commands such as `help`, `system info`, `users list` and `system configuration show`. `sys cfg def ovr` replaces the RESET defaults with the saved draft. `sys cfg sets create RaceDay` saves the draft as a named profile. Use `sys cfg sets load RaceDay` to stage that profile. Account commands open the corresponding management forms, including masked password entry. Account and configuration mutations appear in the audit log.

Chat messages and attachment downloads are restricted to the participants. Attachments default to 8 MiB each and 128 MiB total per sender. Messages and files are stored in SQLite in readable form for the server operator. HTTPS protects them in transit. Deleting an account removes that account and its conversations from both sides.

## Tests, backup and migration

~~~powershell
npm test
~~~

The tests use temporary SQLite databases and sample live-provider responses. They cover login and first-use password changes, permissions, attachment access and size limits, HTTPS proxy validation, account settings, historical and live provider routes, configuration isolation and expiry, and version changes.

After installation, test chat from two devices on the LAN. Sign in as different accounts, send a message and a small file in both directions, and verify that a third account cannot open the file. Repeat over Playit from a device on another network after remote access and licensing are in place.

For Windows Server 2022 or Ubuntu 24.04 LTS, install Node.js 24.11 or newer on the new host, stop the old service, and copy the application and the entire `ADAM_DATA` directory together, including any SQLite sidecar files. Keep backup copies of the data directory private. Provide TLS keys and OpenF1 credentials separately on the new server, then run `node server.mjs` from the application directory. On Ubuntu, launch it under a dedicated systemd service account. Existing accounts, files and version history come from the migrated database, so keep the copied path as `ADAM_DATA` and start it directly.
