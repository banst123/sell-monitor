# Chrome Persistent Window Extension

This project is a Chrome extension that creates a persistent window that remains open for user interactions. Below are the details on how to install, use, and contribute to the extension.

## Features

- Persistent window that stays open
- Background script to manage the extension lifecycle
- Custom styles for the window interface
- TypeScript support for better development experience

## Installation

1. Clone the repository:
   ```
   git clone <repository-url>
   ```

2. Navigate to the project directory:
   ```
   cd chrome-persistent-window-extension
   ```

3. Install the dependencies:
   ```
   npm install
   ```

## Usage

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable "Developer mode" by toggling the switch in the top right corner.
3. Click on "Load unpacked" and select the `src` directory of the project.
4. The extension will be loaded, and you can click on its icon to open the persistent window.

## Development

- The source code is located in the `src` directory.
- The main files include:
  - `manifest.json`: Metadata and configuration for the extension.
  - `background.ts`: Background script for managing the extension.
  - `window.html`: HTML structure for the persistent window.
  - `window.ts`: Logic for handling user interactions in the window.
  - `styles/window.css`: Styles for the persistent window.
  - `types/index.d.ts`: Type definitions for TypeScript.

## Contributing

1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Make your changes and commit them.
4. Push to your branch and create a pull request.

## License

This project is licensed under the MIT License. See the LICENSE file for details.