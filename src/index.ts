import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { SerialPort } from 'serialport';
import { scrapeNotecardApis } from './api.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { findFirmwareUrl, listAvailableFirmwareVersions, getNotecardTypeFromModel } from './firmware.js';
import { validateNotecardRequest } from './schema.js';

const execAsync = promisify(exec);
let discoveredNotecardPort: string | null = null;

const server = new McpServer({
  name: "notecard",
  version: "1.0.0",

}, {
  capabilities: {
    resources: {}
  }
});

server.prompt(
  "check-api-compatibility",
  { api: z.string().describe("The API request to check compatibility for, e.g. 'card.attn'. Use the 'notecard-list-apis' tool to see available APIs.") },
  ({ api }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Can you check if the following API request is compatible with the hardware type of the Notecard?\n\n${api}`
      }
    }]
  })
);

server.tool(
  "notecard-find-port",
  "Scans for connected serial devices with the Notecard VID (30a4) and stores the port, or uses a specified port if provided. If a port is specified, VID checks are skipped. You should make sure to check for available APIs before trying to use other tools.",
  {
    port: z.string().optional().describe("Optional. The serial port to use for the Notecard. If provided, port scanning and VID checks will be skipped."),
  },
  async (input: { port?: string }) => {
    discoveredNotecardPort = null; // Reset port before scanning

    if (input.port) {
      discoveredNotecardPort = input.port;
      console.error(`Using specified Notecard port: ${input.port}`);
      return { content: [{ type: 'text', text: `Using specified Notecard port: ${input.port}` }] };
    }

    try {
      console.error(`Scanning for serial ports...`);
      const ports = await SerialPort.list();
      console.error(`Found ${ports.length} ports. Filtering for Notecard VID 30a4...`);

      const notecardVID = '30a4';
      const notecardPorts = ports.filter(port =>
        port.vendorId && port.vendorId.toLowerCase() === notecardVID
      );

      if (notecardPorts.length === 1) {
        const foundPort = notecardPorts[0].path;
        discoveredNotecardPort = foundPort;
        console.error(`Found and stored Notecard port: ${foundPort}`);
        return { content: [{ type: 'text', text: `Found and stored Notecard port: ${foundPort}` }] };
      } else if (notecardPorts.length === 0) {
        console.error('No Notecard found (VID 30a4).');
        return { content: [{ type: 'text', text: 'Error: No Notecard found connected via USB serial.' }] };
      } else {
        // Multiple Notecards found
        const portPaths = notecardPorts.map(p => p.path).join(', ');
        console.error(`Multiple Notecards found: ${portPaths}`);
        return { content: [{ type: 'text', text: `Error: Multiple Notecards found (${portPaths}). Please specify the 'notecard' port argument manually.` }] };
      }

    } catch (error: any) {
      console.error(`Error scanning for serial ports: ${error}`);
      const errorMessage = error.message || 'Unknown error';
      return { content: [{ type: 'text', text: `Error scanning for Notecard: ${errorMessage}` }] };
    }
  }
);

server.tool(
  "notecard-request",
  "Send a JSON request to a Notecard using 'notecard -req'. Uses previously found port if 'notecard' argument is omitted. ALWAYS run the 'notecard-list-apis' tool at least once before using 'notecard-request', to ensure the request is valid and compatible with the Notecard API.",
  {
    notecard: z.string().optional().describe("Optional: USB port of the Notecard. If omitted, uses port found by 'notecard-find-port'."),
    request: z.string().describe("The JSON request string to send, e.g. '{\"req\":\"card.version\"}', '{\"req\":\"card.wifi\",\"ssid\":\"mySSID\",\"pass\":\"myPassword\"}'")
  },
  async (input: { notecard?: string, request: string }) => {
    const { request } = input;

    let portToUse: string | null = input.notecard || discoveredNotecardPort;

    if (!portToUse) {
      return {
        content: [{
          type: 'text',
          text: "Error: Notecard port not specified and none found previously. Please provide the 'notecard' argument or run 'notecard-find-port' first."
        }]
      };
    }

    console.error(`Using Notecard port: ${portToUse}`);

    // Define trimmedStdout variable at the beginning of the try block
    let trimmedStdout = '';
    try {
      // Construct the command carefully, using the determined port
      const command = `notecard -port ${portToUse} -req '${request}'`;
      console.error(`Executing command: ${command}`); // Log the command being run

      // Use promisified exec for async/await
      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        console.warn(`Stderr output from notecard CLI: ${stderr}`);
        // Continue if stdout has content, otherwise treat stderr as an error signal
        if (!stdout.trim()) {
           // Wrap error in content structure
           return { content: [{ type: 'text', text: `Error: Command failed with stderr: ${stderr}` }] };
        }
      }

      // Trim stdout before parsing to handle potential trailing newlines
      trimmedStdout = stdout.trim();
      console.error(`Raw stdout: ${trimmedStdout}`); // Log raw output

       // Check if stdout is empty after trimming
       if (!trimmedStdout) {
         // Wrap error in content structure
         return { content: [{ type: 'text', text: "Error: Command produced no output." }] };
       }

      // Parse the JSON response from stdout
      const jsonResponse = JSON.parse(trimmedStdout);
      console.error(`Parsed JSON response: ${JSON.stringify(jsonResponse)}`); // Log parsed response
      // Wrap successful JSON response in content structure
      return { content: [{ type: 'text', text: JSON.stringify(jsonResponse) }] };

    } catch (error: any) {
      console.error(`Error executing notecard request: ${error}`);
      if (error instanceof SyntaxError) {
         // Wrap error in content structure, include raw output info
         return { content: [{ type: 'text', text: `Error: Failed to parse JSON response: ${error.message}. Raw output: ${trimmedStdout}` }] };
      }
      // Handle exec errors (command not found, non-zero exit, etc.)
      // The 'error' object from exec includes stdout and stderr if available
      const errorMessage = error.stderr || error.stdout || error.message;
      // Wrap error in content structure
      return { content: [{ type: 'text', text: `Error: Command execution failed: ${errorMessage}` }] };
    }
  },
);

server.tool(
  "notecard-list-firmware-versions",
  "Lists all available firmware versions for a given type.",
  {
    updateChannel: z.string().describe("The type of update to list versions for, e.g. LTS, DevRel, nightly."),
    notecardModel: z.string().describe("The model of Notecard to list versions for, e.g. NOTE-WBEXW, NOTE-NBGL-500, etc."),
  },
  async (input: { updateChannel: string, notecardModel: string }) => {
    const { updateChannel, notecardModel } = input;

    const notecardType = getNotecardTypeFromModel(notecardModel);

    if (notecardType === null) {
      return { content: [{ type: 'text', text: `Error: Could not determine Notecard type for model '${notecardModel}'. Check the provided model.` }] };
    }

    console.error(`Determined notecardType: ${notecardType} for model: ${notecardModel}`); // Add logging

    const versions = await listAvailableFirmwareVersions(updateChannel, notecardType);
    return { content: [{ type: 'text', text: `Available firmware versions for ${updateChannel}: ${versions.join(', ')}` }] };
  }
);

server.tool(
  "notecard-update-firmware",
  "Updates the Notecard firmware. IMPORTANT: This process can take several minutes and will run in the background after the command returns. Instruct the user to wait for the red LED to stop flashing, once they have confirmed this, check the card.version request to return a successful response to check if the update is successful.",
  {
    notecard: z.string().optional().describe("Optional: USB port of the Notecard. If omitted, uses port found by 'notecard-find-port'."),
    updateVersion: z.string().optional().describe("Optional: The version to update to (e.g., 6.2.5.16868). If this is known, it should be provided. If omitted, updates to the latest version."),
    currentVersion: z.string().optional().describe("Optional: The current version of the Notecard. Use the card.version request to get this."),
    updateChannel: z.string().optional().describe("Optional: The update channel to download; 'LTS' (Long Term Support), 'DevRel' (Developer Release), or 'nightly'. If omitted, set to LTS."),
    notecardModel: z.string().describe("The model of Notecard to update, e.g. NOTE-WBEXW, NOTE-NBGL-500, etc."),
  },
  async (input: { notecard?: string, updateVersion?: string, updateChannel?: string, notecardModel?: string, currentVersion?: string }) => { // Corrected type: version is optional
    const { updateVersion, updateChannel, notecardModel } = input;
    let portToUse: string | null = input.notecard || discoveredNotecardPort; // Use provided or discovered port
    let versionToUse: string = updateVersion || 'latest'; // Default to latest, ensure it's string
    let currentVersion: string | null = input.currentVersion || null;
    let updateChannelToUse: string = updateChannel || 'LTS'; // Default to LTS, ensure it's string

    const validTypes = ['LTS', 'DevRel', 'nightly'];
    if (!validTypes.includes(updateChannelToUse)) {
      return { content: [{ type: 'text', text: `Error: Invalid update type. Must be one of: ${validTypes.join(', ')}.` }] };
    }

    const notecardType = getNotecardTypeFromModel(notecardModel);
    console.error(`Determined notecardType: ${notecardType} for model: ${notecardModel}`);

    // Check if a valid notecardType was determined (returns null on failure)
    if (notecardType === null) {
      return {
        content: [{ type: 'text', text: `Error: Could not determine Notecard type for model '${notecardModel}'. Check the provided model.` }]
      };
    }

    // Check if we have a port to use
    if (!portToUse) {
      return {
        content: [{ type: 'text', text: "Error: Notecard port not specified and none found previously. Please provide the 'notecard' argument or run 'notecard-find-port' first." }]
      };
    }

    try {
      let firmwareUrl = await findFirmwareUrl(updateChannelToUse, notecardType, versionToUse, currentVersion);

      if (firmwareUrl === null) {
        return { content: [{ type: 'text', text: `Firmware is already up to date (Current: ${currentVersion}, Latest for ${updateChannelToUse}/${notecardType}: ${versionToUse} determined during check).` }] };
      }

      let tempFilePath: string | null = null;
      try {
        // 1. Download the firmware file
        console.error(`Downloading firmware from: ${firmwareUrl}`);
        const firmwareResponse = await fetch(firmwareUrl);
        if (!firmwareResponse.ok) {
          throw new Error(`Failed to download firmware: ${firmwareResponse.status} ${firmwareResponse.statusText}`);
        }
        const firmwareFile = await firmwareResponse.arrayBuffer();
        console.error(`Firmware file downloaded (${firmwareFile.byteLength} bytes).`);

        // 2. Save the firmware file to a temporary file
        tempFilePath = path.join(os.tmpdir(), `notecard-firmware-${Date.now()}.bin`);
        await fs.writeFile(tempFilePath, Buffer.from(firmwareFile));
        console.error(`Firmware file saved to: ${tempFilePath}`);

        // 3. Construct command arguments for spawn
        const args = [
          '-port',
          portToUse,
          '-fast',
          '-sideload',
          tempFilePath
        ];
        console.error(`Spawning command: notecard ${args.join(' ')}`);

        // 4. Spawn the process in the background
        const child = spawn('notecard', args, {
          detached: true,
          stdio: 'ignore'
        });

        // 5. Allow the parent process to exit without waiting for the child
        child.unref();

        // 6. Return immediately indicating the process has started
        return {
          content: [{ type: 'text', text: `Firmware update process started in the background for port ${portToUse} using ${firmwareUrl}. Sideloading from ${tempFilePath}. Check device status manually.` }]
        };

      } catch (error: any) {
        console.error(`Error starting firmware update process: ${error}`);
        let errorMessage = error.message || 'Unknown error starting update';
        if (error.code === 'ENOENT') {
          errorMessage = "Error: 'notecard' command not found. Is the CLI installed and in the PATH?";
        }
        if (tempFilePath) {
          errorMessage += ` (Temporary file created: ${tempFilePath})`;
        }
        return { content: [{ type: 'text', text: errorMessage }] };
      }

    } catch (error: any) {
      console.error(`Error preparing for firmware update: ${error}`);
      return {
        content: [{ type: 'text', text: `Error preparing update: ${error.message || 'Unknown error'}` }]
      };
    }
  }
);

server.tool(
  "notecard-list-apis",
  "Fetches the list of available Notecard API request types (e.g., card.attn) and their compatible hardware types from the Blues documentation website.",
  {},
  async (_input: {}) => {
    const result = await scrapeNotecardApis();

    if ('error' in result) {
      return { content: [{ type: 'text', text: result.error }] };
    } else {
      try {
        const apiListJson = JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text: apiListJson }] };
      } catch (jsonError: any) {
        console.error(`Error stringifying API list result: ${jsonError}`);
        return { content: [{ type: 'text', text: `Internal Server Error: Could not format API list.` }] };
      }
    }
  }
);

async function main() {
  // Check for Notecard CLI on PATH
  const notecardPath = await execAsync('which notecard');
  if (notecardPath.stderr) {
    console.error("Notecard CLI not found on PATH. Please install the Notecard CLI and try again.");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Notecard MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

