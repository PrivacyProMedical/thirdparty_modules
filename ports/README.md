This folder contains the registry list of third-party modules.

## Optional MCP declaration

An installed module may contribute MCP servers to MediOrdo's aggregate MCP
gateway by adding an optional `mcp` object to its own port JSON:

```json
{
  "mcp": {
    "servers": [
      {
        "id": "example",
        "serverName": "example",
        "transport": "stdio",
        "command": "${MEDIORDO_EXECUTABLE}",
        "args": ["${MODULE_DIR}/mcp/server.mjs"],
        "env": { "ELECTRON_RUN_AS_NODE": "1" },
        "toolCallTimeoutMs": 60000
      }
    ]
  }
}
```

Rules:

- Only installed modules are activated. A catalogue entry that is merely visible
  in the Module Manager does not start a process.
- `serverName` is required and must be unique across the host and all installed
  modules. `id` defaults to `serverName`; `enabled` defaults to `true`.
- Both `stdio` and `streamable-http` transports are accepted.
- Tools are exposed through the single `pmt` connection as
  `mcp__pmt__<serverName>__<tool>`. Resources use
  `pmt-gateway://<serverName>/<encoded-uri>`.
- `${MODULE_DIR}` is the installed module directory. The host also supplies
  `${MEDIORDO_EXECUTABLE}`, `${MEDIORDO_MCP_SHIM}`,
  `${MEDIORDO_WORKSPACE}`, and `${ENV:NAME}`.
- Port JSON is public registry metadata. Never put absolute local paths, tokens,
  passwords, or other secrets in it. Reference secrets through `${ENV:NAME}`.
- The gateway owns connection startup, tool discovery, timeouts, process
  shutdown, and status reporting. Module port metadata does not need a separate
  health-check command.
