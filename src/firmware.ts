// Helper function to compare semantic versions (simplified)
function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const len = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < len; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }

// NEW Helper function to extract keys from S3 XML response
function extractKeysFromXml(xmlString: string): string[] {
  const keyRegex = /<Key>(.*?)<\/Key>/g;
  let match;
  const keys: string[] = [];
  while ((match = keyRegex.exec(xmlString)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

// NEW Helper function to extract available versions from S3 keys
function extractAvailableVersions(relevantKeys: string[]): string[] {
  const availableVersions: Set<string> = new Set(); // Use Set for uniqueness
  const versionRegex = /-(\d+\.\d+\.\d+\.\d+)\.(?:bin|dfu)/;

  for (const key of relevantKeys) {
    const versionMatch = key.match(versionRegex);
    if (versionMatch && versionMatch[1]) {
      availableVersions.add(versionMatch[1]);
    }
  }
  return Array.from(availableVersions); // Convert Set back to Array
}

// NEW Function to list all available firmware versions for a given type
export async function listAvailableFirmwareVersions(
  updateType: string,
  notecardType: string
): Promise<string[]> {
  try {
    // 1. Fetch firmware index
    const firmwareIndexUrl = `https://s3.us-east-1.amazonaws.com/notecard-firmware?prefix=${updateType}`;
    console.error(`Fetching firmware index for listing: ${firmwareIndexUrl}`);
    const firmwareIndexXml = await fetch(firmwareIndexUrl).then(res => {
      if (!res.ok) {
        throw new Error(`Failed to fetch firmware index: ${res.status} ${res.statusText}`);
      }
      return res.text();
    });

    // 2. Extract all keys
    const allKeys = extractKeysFromXml(firmwareIndexXml);
    if (allKeys.length === 0) {
      console.error(`No firmware files found in S3 XML for prefix '${updateType}'. Returning empty list.`);
      return []; // Return empty array if no keys found at all for the prefix
    }

    // 3. Filter keys relevant to notecardType
    const relevantKeys = allKeys.filter(key => key.includes(`-${notecardType}-`));
    if (relevantKeys.length === 0) {
       console.error(`No firmware files found for Notecard type '${notecardType}' with prefix '${updateType}'. Returning empty list.`);
       return []; // Return empty array if no relevant keys for the specific notecard type
    }
    console.error(`Found ${relevantKeys.length} relevant keys for type '${notecardType}' for listing versions.`);

    // 4. Extract and return unique versions
    const availableVersions = extractAvailableVersions(relevantKeys);
    console.error(`Extracted available versions: ${availableVersions.join(', ')}`);
    return availableVersions;

  } catch (error: any) {
    console.error(`Error listing available firmware versions: ${error.message}`);
    // Re-throw the error for the caller to handle
    throw new Error(`Could not list firmware versions: ${error.message}`);
  }
}

// NEW Function to determine Notecard type ('u5', 'wl', 's3', '') from model string
export function getNotecardTypeFromModel(notecardModel: string | null | undefined): string | null {
  // Mapping from firmware type prefix ('u5', 'wl', 's3', '') to substrings found in model names
  const notecardTypeMap = {
    "": ["500"], // e.g., "NOTE-NBGL-500" maps to ""
    "u5": ["NB","MB","WB"], // e.g., "NOTE-WBNA", "NOTE-NBGL", "NOTE-MBNA" map to "u5"
    "wl": ["LW"], // e.g., "NOTE-LWL" maps to "wl"
    "s3": ["ESP"], // e.g., "NOTE-ESP32" maps to "s3"
  };

  if (!notecardModel) {
    return null; // Cannot determine type without a model
  }

  for (const [key, modelSubstrings] of Object.entries(notecardTypeMap)) {
    for (const substring of modelSubstrings) {
      if (notecardModel.includes(substring)) {
        return key; // Return the type ('u5', 'wl', 's3', '')
      }
    }
  }

  return null; // Return null if no match found
}

// Helper function to find the appropriate firmware URL
export async function findFirmwareUrl(
    updateType: string,
    notecardType: string,
    versionToUse: string,
    currentVersion: string | null
  ): Promise<string | null> { // Returns URL or null if up-to-date, throws error otherwise
    try {
      // Download the latest firmware index from Blues
      const firmwareIndexUrl = `https://s3.us-east-1.amazonaws.com/notecard-firmware?prefix=${updateType}`;
      console.error(`Fetching firmware index: ${firmwareIndexUrl}`);
      const firmwareIndexXml = await fetch(firmwareIndexUrl).then(res => {
        if (!res.ok) {
          throw new Error(`Failed to fetch firmware index: ${res.status} ${res.statusText}`);
        }
        return res.text();
      });

      // 1. Extract keys from XML
      const allKeys = extractKeysFromXml(firmwareIndexXml);
      console.error(`Found ${allKeys.length} keys in XML for prefix '${updateType}'.`);

      if (allKeys.length === 0) {
        throw new Error(`No firmware files found in S3 XML for prefix '${updateType}'.`);
      }

      // 2. Filter keys relevant to notecardType
      const relevantKeys = allKeys.filter(key => key.includes(`-${notecardType}-`));
      console.error(`Found ${relevantKeys.length} relevant keys for type '${notecardType}'.`);

      if (relevantKeys.length === 0) {
        throw new Error(`No firmware files found for Notecard type '${notecardType}' with prefix '${updateType}'.`);
      }

      // 3a. Extract all available versions for potential error messages
      const availableVersions = extractAvailableVersions(relevantKeys);
      console.error(`Found available versions: ${availableVersions.join(', ')}`);

      // 3b. Find the desired key and version
      let selectedKey: string | null = null;
      let latestVersion = '0.0.0.0';
      const versionRegex = /-(\d+\.\d+\.\d+\.\d+)\.(?:bin|dfu)/; // Regex for selection logic

      for (const key of relevantKeys) {
        const versionMatch = key.match(versionRegex);
        if (versionMatch && versionMatch[1]) {
          const keyVersion = versionMatch[1];

          if (versionToUse === 'latest') {
            if (compareVersions(keyVersion, latestVersion) > 0) {
              latestVersion = keyVersion;
              selectedKey = key;
            }
            else if (compareVersions(keyVersion, latestVersion) === 0 && selectedKey && !key.endsWith('.bin') && selectedKey.endsWith('.dfu')) {
               selectedKey = key;
            }
          } else if (keyVersion === versionToUse) {
             if (!selectedKey || (selectedKey && !selectedKey.endsWith('.bin') && key.endsWith('.bin')) || key.endsWith('.bin')) {
                 selectedKey = key;
             }
          }
        }
      }
       console.error(`Determined latest available version: ${latestVersion}`);
       console.error(`Selected key: ${selectedKey}`);

      // Check if already up-to-date (only if 'latest' was requested implicitly or explicitly)
      if (versionToUse === 'latest' && currentVersion && compareVersions(currentVersion, latestVersion) >= 0) {
        console.error(`Current version ${currentVersion} is up-to-date with latest ${latestVersion}.`);
        return null;
      }

      // Handle case where specific version was requested but not found
      if (versionToUse !== 'latest' && !selectedKey) {
        throw new Error(`Firmware version '${versionToUse}' not found for Notecard type '${notecardType}'. Available: ${availableVersions.join(', ') || 'None'}`);
      }

      // Handle case where 'latest' was requested but no valid versions were found
      if (versionToUse === 'latest' && !selectedKey) {
        // Use the extracted list if availableVersions is not empty
        const availableMsg = availableVersions.length > 0 ? ` Available: ${availableVersions.join(', ')}` : '';
        throw new Error(`Could not find any valid firmware versions for Notecard type '${notecardType}'.${availableMsg}`);
      }

      // 4. Construct URL
      if (selectedKey) {
        const firmwareUrl = `https://notecard-firmware.s3.amazonaws.com/${selectedKey}`;
        console.error(`Selected firmware key '${selectedKey}' resulting in URL: ${firmwareUrl}`);
        return firmwareUrl;
      } else {
        // This case should be covered by previous checks, but acts as a failsafe
        throw new Error(`Could not determine appropriate firmware key after filtering.`);
      }

    } catch (error: any) {
      console.error(`Error finding firmware URL: ${error.message}`);
      // Re-throw the error to be caught by the main tool handler
      throw new Error(`Could not find firmware: ${error.message}`);
    }
  }