
<p align="center">
  <img src="./icon.svg" alt="Blockyard logo" width="96" />
</p>

<h1 align="center">Blockyard</h1>

<p align="center">
  Build automation workflows with blocks, from event triggers and data processing to external integrations, without writing code.
</p>

Blockyard is a visual workflow tool built with Blockly, React, and Python. Connect the blocks that define when a workflow starts and what happens next. Blockyard converts them into an intermediate representation (IR) and executes it with a Python runtime.

```text
[Discord message received] ──▶ [Process message] ──▶ [Send a Discord reply]

[Scheduled time reached] ────▶ [Read data] ────────▶ [Call an external service]
```

## Features

- Build, save, and run workflows with drag-and-drop blocks
- Trigger workflows with schedules, webhooks, and Discord events
- Connect to HTTP services, OpenAI, and Discord through extensions
- Use variable interpolation, object and list access, and multiline text
- Run extensions in separate subprocesses and virtual environments

## Demos

### Discord Bot

Receive Discord messages and work with object data.

[Watch the Discord Bot demo](https://github.com/user-attachments/assets/3dc86291-3ae5-4094-9420-b6e83015916e)

### AI Discord Bot

Connect AI-generated replies to a Discord bot.

[Watch the AI Discord Bot demo](https://github.com/user-attachments/assets/5d781c67-a719-4f9a-a567-0ebccb789a36)


## Quick Start

### Requirements

- Python 3.12 or 3.13 (3.12 recommended)
- [uv](https://docs.astral.sh/uv/)
- Node.js 20.19 or later
- npm

### Install and Run

Run these commands from the project root:

```bash
cd packages/editor
npm ci
npm run build

cd ../../backend
uv sync
uv run blockyard serve
```

The server starts at <http://127.0.0.1:8787> and opens your browser automatically. Press `Ctrl+C` in the terminal to stop it.

On the first launch, Blockyard creates local data and installs bundled extensions in `~/.blockyard/`. API keys are stored in your operating system's keyring, rather than in project files or this repository.

### Common Server Options

```bash
# Start without opening a browser
uv run blockyard serve --no-open

# Use a different port
uv run blockyard serve --port 9000

# Reload automatically during backend development
uv run blockyard serve --reload --no-open
```

Blockyard listens on `127.0.0.1` by default. Extensions can execute Python code, so only install extensions you trust. Add authentication and isolation before exposing the service to the public internet.

## Usage

1. Open Blockyard and create a project.
2. Drag event or action blocks from the toolbox on the left and connect them in order.
3. Add any API keys your workflow needs in Settings.
4. Click Run to test the workflow. Enable the project to keep listening for events.

### Text and Variables

- Press `Shift` + `Enter` in a text field to insert a line break.
- Use `${message}` to read a variable.
- Use `${user.name}` or `${items[1]}` to access object properties and list items.

#### Multiline Text Demo

Enter multiple lines directly into a block's text field.

[Watch the multiline text demo](https://github.com/user-attachments/assets/2d24a0a2-6a74-4665-807c-2b3d7c8f35f3)

#### Variable Lookup Order

When variables share the same name, Blockyard searches from the innermost scope outward:

1. Function parameters or temporary variables for the current invocation
2. Local variables bound to blocks, such as a Discord message or a loop item
3. Global variables within the same workflow run

## Development

Run the backend and the frontend development server with hot module replacement (HMR) in separate terminals.

Terminal 1:

```bash
cd backend
uv sync --extra dev
uv run blockyard serve --no-open
```

Terminal 2:

```bash
cd packages/editor
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/api`, `/ws`, and `/hooks` to `127.0.0.1:8787`.

### Checks and Tests

```bash
# Backend tests and linting
cd backend
uv run pytest
uv run ruff check .

# Frontend type checking and tests
cd ../packages/editor
npm run check
```

See [`docs/`](./docs/README.md) for more details on the architecture and extensions.

## License

This project is licensed under the [MIT License](./LICENSE). You may use, modify, and distribute it as long as you retain the original license and copyright notice.
