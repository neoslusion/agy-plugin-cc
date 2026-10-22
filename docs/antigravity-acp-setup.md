# Antigravity ACP setup on Windows

Use the dedicated Google Antigravity ACP runtime, not the ordinary `agy` CLI. This follows the [official ACP Registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) and [T3's runtime installation instructions](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-antigravity.md#runtime-installation). The registry supplies the current Windows x64 or ARM64 package; its version is not hardcoded into the installer.

From the project directory:

```powershell
node --test tests/antigravity-runtime.test.mjs
node scripts/agent-runner.mjs acp-setup --check --json
node scripts/agent-runner.mjs acp-setup --install
node scripts/agent-runner.mjs acp-setup --check --json
```

The check looks for `AGY_ACP_BINARY`, then the project's managed runtime, then `agy_acp_server.exe` or `agy_acp_server.par` on `PATH`. It checks that the executable and its `localharness_external` helper are present together. `ready` means those files exist; it does not establish successful ACP initialization, Google authentication or model eligibility. JSON makes that distinction explicit with `protocolVerified: false` and `authenticated: null`.

Installation reuses a complete existing runtime. Otherwise it obtains the registry entry over HTTPS and streams the Windows archive directly from `dl.google.com`. It refuses unexpected commands, hosts, redirects, archive path traversal and links. Extraction requires Windows PowerShell and is bounded. Both executables are kept from one archive, and a complete installation is published through `current.json`. A concurrent installer fails with a lock message rather than downloading a second archive. An interrupted installer may leave `install.lock`; verify that installer stopped before removing it.

The default directory is `.agent-delegation-runtime/antigravity-acp/` inside this project, which is gitignored. Allow several GB of free disk space. No global `PATH`, host model, approval setting or credential is changed. The archive SHA-256 is recorded for audit; the current registry does not publish an independent checksum, so this is not a claim of independent signature verification.

The ACP adapter automatically discovers the default managed installation. To choose it, merge this into `.agent-delegation.json`:

```json
{
  "executors": {
    "agy": { "integration": "acp" }
  }
}
```

Or select it for one task without changing the configuration:

```powershell
node scripts/agent-runner.mjs task --executor agy --integration acp --json "Reply only with PONG; do not use tools or change files."
```

The actual task may require the runtime's separate Google sign-in or report account/model restrictions. Installing the runtime does not reuse or copy the ordinary `agy` CLI's login. ACP schema-constrained supervisor roles are still unsupported; keep CLI for those roles. No download is triggered by a normal model task: missing runtime errors direct the parent to the explicit setup command.

For a shared runtime directory:

```powershell
node scripts/agent-runner.mjs acp-setup --install --directory "C:\path\to\acp-runtime"
node scripts/agent-runner.mjs acp-setup --check --directory "C:\path\to\acp-runtime" --json
$env:AGY_ACP_BINARY = "<binary path returned by setup>"
```

Use that environment variable when switching projects or launching a host with a custom installation. An incomplete explicitly configured runtime produces an error instead of silently selecting another one. A different directory does not automatically change the parent's environment. Rebuild the plugin with `npm run package` before using these new commands from an installed plugin copy.

## Validation status

Offline tests in `tests/antigravity-runtime.test.mjs` cover discovery, architecture selection, trusted download URLs, publication, repeat-install reuse, incomplete packages, failures, metadata containment, concurrent installation and worker restrictions. Download tests use fake archive contents and a fixture extractor. Two Windows-only tests exercise the real extractor with synthetic valid and malicious ZIP files. None validate Google's real archive or authentication.

On 2026-10-04, the focused suite passed all 30 tests: installer/discovery checks, real Windows extraction of synthetic ZIP files, existing provider adapters, and the new setup command running from an isolated packaged plugin. Packaging rebuilt the plugin runtime. The first Windows test run reported `Unable to find type [IO.Compression.ZipArchiveMode]`; explicitly loading `System.IO.Compression` fixed it.

Direct shell commands remained blocked with `CreateProcessAsUserW failed: -1073283067`, including the actual `acp-setup --install` attempt, which failed before Node started. Consequently no real Google archive was downloaded, this machine's actual runtime/authentication status could not be established, and live ACP compatibility remains unverified. Run the setup command from your normal terminal to perform the actual installation.
