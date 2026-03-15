# Coast Runtime

This project uses Coasts (containerized host) for isolated development environments.
Your code edits are automatically visible inside the running Coast — the filesystem
is shared between the host and the container.

## Orientation

Before running any runtime commands, discover which Coast instance matches your
current working directory:

```
coast lookup
```

This prints the instance name, ports, URLs, and example commands. Use the instance
name from the output for all subsequent commands.

If you need deeper context on how Coasts work, read these docs:

```
coast docs --path concepts_and_terminology/LOOKUP.md
coast docs --path concepts_and_terminology/FILESYSTEM.md
coast docs --path concepts_and_terminology/EXEC_AND_DOCKER.md
coast docs --path concepts_and_terminology/LOGS.md
```

## Running Commands

Use `coast exec` to run commands inside the Coast. The shell starts at the workspace
root (where the Coastfile is). cd to your target directory first:

```
coast exec <instance> -- sh -c "cd <dir> && <command>"
```

Examples:

```
coast exec dev-1 -- sh -c "cd src && npm test"
coast exec dev-1 -- sh -c "cd backend && go test ./..."
coast exec dev-1 -- sh -c "cd apps/web && npx playwright test"
```

## Runtime Feedback

Check service status:

```
coast ps <instance>
```

Read service logs:

```
coast logs <instance> --service <service>
coast logs <instance> --service <service> --tail 50
```

## Troubleshooting

If you encounter errors or unfamiliar behavior, search the Coast docs:

```
coast search-docs "error message or description"
```

This uses semantic search — describe the problem in natural language and it will
find the relevant documentation.

## Rules

- Always run `coast lookup` before your first runtime command in a session.
- Do not run services directly on the host. Use `coast exec` for all runtime tasks.
- File edits on the host are instantly visible inside the Coast. You do not need
  to copy files or rebuild after editing.
- If `coast lookup` returns no instances, the Coast may not be running. Suggest
  `coast run dev-1` or check `coast ls` for the project state.
