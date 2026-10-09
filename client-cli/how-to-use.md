# How to use `cmn`

Standalone SSH launcher for **ubuntu@194.32.141.123:22**.
Authentication: **password**. Files: `cmn` (macos).
Use the file for your operating system. Windows runs the `.exe` directly;
on Unix use `./` before the filename. The examples use `./cmn`.

## First run — user setup

A human must run the launcher once in a terminal and enter the SSH password in its
hidden prompt. After successful authentication it is saved in the OS credential
store (Windows Credential Manager, macOS Keychain, Linux Secret Service).
AI agents must never request the secret in chat, supply it via argv/environment,
or capture its prompt. If `CREDENTIAL_SETUP_REQUIRED` appears, ask the user to
complete this terminal setup. Subsequent agent runs retrieve the secret privately.

No password is stored in this executable. No passwords or passphrases are passed on command lines, exported as
environment variables, or written to temporary files. Secret values are held in
process memory during authentication; Falco cannot control external crash dumps
or an agent with unrestricted access to the user's OS account.

On macOS/Linux a copied launcher may need its executable bit restored:

```sh
chmod +x cmn
```

On macOS, right-click → Open once, or run `xattr -d com.apple.quarantine cmn` if Gatekeeper quarantines the unsigned launcher.

## Running commands

```sh
./cmn "cd /srv/app && git pull && docker compose up -d"
./cmn docker ps
./cmn --stdin deploy.sh
./cmn                           # interactive terminal
```

Use `--` before a remote command to keep local-looking arguments remote, e.g.
`./cmn -- git branch --list`.

Commands run only on the remote server. Remote stdout/stderr stream live;
command execution returns the real remote exit code. Falco does not retry commands.

## File transfer

```sh
./cmn --upload ./app.zip /srv/app.zip
./cmn --download /var/log/app.log ./app.log
./cmn --list /srv
./cmn --mkdir /srv/new
./cmn --remove /srv/old
./cmn --move /srv/a /srv/b
./cmn --upload-dir ./dist /var/www
./cmn --download-dir /var/log ./logs
```

Only one transfer action per invocation. Add `--overwrite` to replace existing
files or `--mkdirs` to create missing destinations. Downloads are staged before
replacement. Interrupted transfers fail; inspect the destination before retrying.

## Troubleshooting — instructions for AI agents

Falco's own errors are single-line JSON on stderr with `error`, `message`,
`action` and optional `target`/`details`. Remote stderr is passed through unchanged.
Exit groups: 2 = arguments/config; 3 = local credentials; 4 = SSH/remote failure.
A remote command's nonzero status is that command's status, not automatically a
Falco error. A disconnected command with unknown status is never reported as success.

- `DNS_LOOKUP_FAILED`: check the configured hostname and DNS/private-network access.
- `CONNECTION_REFUSED`: check the host/port and whether SSH is listening.
- `NETWORK_UNREACHABLE` / `CONNECTION_TIMEOUT`: the connection failed or times out.
  Check host/IP, port, network/VPN and server availability. Do not infer a wrong
  password or that the user is "not logged in" from a timeout. Compare with
  `ssh ubuntu@194.32.141.123 -p 22` if needed.
- `AUTHENTICATION_FAILED`: the server rejected authentication. Ask the user to
  check account/key authorization and refresh the stored secret in a terminal:
  `./cmn --reset-credential`. Password mode also accepts `--reset-password`.
- `KEY_DECRYPTION_FAILED`: ask the user to reset the stored passphrase and enter
  it again privately. A damaged/unsupported key may require rebuilding.
- `CREDENTIAL_STORE_UNAVAILABLE`: unlock/start the OS credential store; on Linux
  provide a running Secret Service (GNOME Keyring/KWallet). No insecure fallback.

## Connection security — host identity

The SSH session is encrypted. Host identity uses **trust on first use**: Falco
remembers the first observed server key for this host/port in the OS credential
store. This protects later connections against changed keys, but the first
connection still needs a trusted network or independently verified server identity.

`HOST_KEY_CHANGED` means: **Server key changed. If you accept this change, retry
with --accept-new-key.** Expected and observed fingerprints are included in the
error. AI agents must ask the user to verify and approve the new fingerprint
before using this flag; never automatically bypass the error.

After user approval, retry the original invocation with `--accept-new-key` before
the remote command/action, e.g. `./cmn --accept-new-key "docker ps"`.
Credential reset does not clear host trust. Keys/passphrases are stored separately;
sharing a launcher requires fresh credential setup on each recipient's machine.
