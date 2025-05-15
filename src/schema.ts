import Ajv, { SchemaObject, ValidateFunction } from 'ajv';
// Import fs and path for manual JSON loading
import * as fs from 'fs/promises';
import * as path from 'path';

const NOTECARD_SCHEMA_URL = "https://raw.githubusercontent.com/blues/notecard-schema/refs/heads/master/notecard.api.json";

let ajv: Ajv | null = null;
let validate: ValidateFunction | null = null;
let schemaFetchPromise: Promise<void> | null = null;

let mainSchema: SchemaObject | null = null;
let mainSchemaFetchPromise: Promise<SchemaObject> | null = null;

// Fetches the schema and initializes Ajv
async function initializeSchemaValidation(): Promise<void> {
  try {
    console.log(`Fetching Notecard schema from ${NOTECARD_SCHEMA_URL}...`);
    const response = await fetch(NOTECARD_SCHEMA_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
    }
    const schema = await response.json() as SchemaObject;
    console.log("Schema fetched successfully.");

    // Initialize Ajv, allowing Draft 2020 keywords by disabling strict mode
    ajv = new Ajv({ allErrors: true, strict: false });

    // Compile the main Notecard schema. Ajv should handle the $schema keyword.
    validate = ajv.compile(schema);
    console.log("Notecard schema compiled successfully.");

  } catch (error) {
    console.error("Error initializing schema validation:", error);
    // Reset state on failure
    ajv = null;
    validate = null;
    schemaFetchPromise = null; // Allow retrying
    throw error; // Re-throw to signal initialization failure
  }
}

// Ensures schema is fetched and Ajv is initialized, handling concurrent requests
async function ensureInitialized(): Promise<void> {
  if (!ajv || !validate) { // Check if initialization is needed
    if (!schemaFetchPromise) { // Check if a fetch is already in progress
      // Start the initialization process
      schemaFetchPromise = initializeSchemaValidation();
    }
    // Wait for the ongoing or new initialization to complete
    await schemaFetchPromise;
  }
  // If initialization failed previously, ajv/validate might still be null
  if (!ajv || !validate) {
    throw new Error("Schema validation initialization failed.");
  }
}

/**
 * Validates a Notecard request JSON string against the official Notecard API schema.
 * @param requestJson The JSON string representing the Notecard request.
 * @returns An object indicating whether the request is valid and any validation errors.
 */
export async function validateNotecardRequest(requestJson: string): Promise<{ valid: boolean; errors?: any[] | null }> {
  try {
    await ensureInitialized();

    // Ensure ajv and validate are available after initialization attempt
    if (!ajv || !validate) {
        // This should theoretically not be reached if ensureInitialized works correctly,
        // but provides a safeguard.
        throw new Error("Schema validation components are not initialized.");
    }

    let requestData;
    try {
      requestData = JSON.parse(requestJson);
    } catch (parseError) {
      return { valid: false, errors: [{ message: `Invalid JSON: ${(parseError as Error).message}` }] };
    }

    const isValid = validate(requestData);

    if (isValid) {
      return { valid: true };
    } else {
      return { valid: false, errors: validate.errors };
    }
  } catch (error) {
    console.error("Error during validation:", error);
    return { valid: false, errors: [{ message: `Validation process error: ${(error as Error).message}` }] };
  }
}

// Fetches the main schema definition
async function fetchMainSchema(): Promise<SchemaObject> {
  if (mainSchema) {
    return mainSchema;
  }
  if (mainSchemaFetchPromise) {
    return mainSchemaFetchPromise;
  }

  mainSchemaFetchPromise = (async () => {
    try {
      console.log(`Fetching main Notecard schema from ${NOTECARD_SCHEMA_URL}...`);
      const response = await fetch(NOTECARD_SCHEMA_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch main schema: ${response.status} ${response.statusText}`);
      }
      const schema = await response.json() as SchemaObject;
      console.log("Main schema fetched successfully.");
      mainSchema = schema; // Cache the schema
      return schema;
    } catch (error) {
      console.error("Error fetching main schema:", error);
      mainSchemaFetchPromise = null; // Allow retrying on failure
      throw error;
    }
  })();

  return mainSchemaFetchPromise;
}

/**
 * Generates a map of valid Notecard requests and their parameters by fetching and parsing the individual schemas.
 * @returns An object where keys are request names (e.g., "card.version") and values are objects
 *          mapping parameter names to their descriptions or types.
 */
export async function generateRequestParameterMap(): Promise<Record<string, Record<string, any>>> {
  const requestMap: Record<string, Record<string, any>> = {};

  try {
    const schema = await fetchMainSchema();

    if (!schema.oneOf || !Array.isArray(schema.oneOf)) {
      throw new Error("Main schema does not contain a valid 'oneOf' array.");
    }

    const fetchPromises = schema.oneOf.map(async (refObj: any) => {
      if (!refObj.$ref || typeof refObj.$ref !== 'string') {
        console.warn("Skipping invalid $ref in oneOf array:", refObj);
        return; // Skip if $ref is missing or not a string
      }
      const subSchemaUrl = refObj.$ref;

      try {
        // console.log(`Fetching sub-schema: ${subSchemaUrl}`); // Optional: verbose logging
        const response = await fetch(subSchemaUrl);
        if (!response.ok) {
          console.warn(`Failed to fetch sub-schema ${subSchemaUrl}: ${response.status} ${response.statusText}`);
          return; // Skip this schema on fetch error
        }
        const subSchema = await response.json() as SchemaObject;

        // --- Extract Request Name and Parameters ---
        if (subSchema.properties && subSchema.properties.req && (subSchema.properties.req as any).const) {
          const reqName = (subSchema.properties.req as any).const as string;
          const parameters: Record<string, any> = {};

          for (const paramName in subSchema.properties) {
            if (paramName !== 'req' && Object.prototype.hasOwnProperty.call(subSchema.properties, paramName)) {
              const paramDef = subSchema.properties[paramName] as any;
              // Store description if available, otherwise type or empty object
              parameters[paramName] = paramDef.description || paramDef.type || {};
            }
          }
          // console.log(`Found request: ${reqName} with params:`, Object.keys(parameters)); // Optional: logging
          requestMap[reqName] = parameters;
        } else {
          console.warn(`Could not extract request name from sub-schema: ${subSchemaUrl}`);
        }
        // --- End Extraction ---

      } catch (error) {
        console.warn(`Error processing sub-schema ${subSchemaUrl}:`, error);
      }
    });

    // Wait for all sub-schema fetches and processing to complete
    await Promise.all(fetchPromises);

  } catch (error) {
    console.error("Error generating request parameter map:", error);
    // Return potentially partially filled map or throw error depending on desired behavior
    // For now, return what we have
  }

  console.log(`Generated map for ${Object.keys(requestMap).length} requests.`);
  return requestMap;
}

// Ensure newline at the end of the file
