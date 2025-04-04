import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs/promises'; // Import fs promises API
import * as path from 'path'; // Import path module

// Define the structure for scraped argument details
interface NotecardApiArgument {
  name: string;
  type: string | null;
  description: string | null;
  optional: boolean;
  validValues?: string[]; // Specific enum-like values derived from leading <code> tags
}

// Updated structure for the scraped API details
interface NotecardApiDetail {
  request: string;
  types: string[]; // e.g., ['Cell', 'WiFi']
  arguments: NotecardApiArgument[];
}

// Parses the Notecard type badges (e.g., Cell Cell+WiFi LoRa) into an array.
function parseTypesString(typesString: string): string[] {
  const knownTypes = ['Cell+WiFi', 'Cell', 'LoRa', 'WiFi']; // Order matters: longest first
  const parsedTypes: string[] = [];
  let remainingString = typesString.trim();

  while (remainingString.length > 0) {
    let foundMatch = false;
    for (const type of knownTypes) {
      if (remainingString.startsWith(type)) {
        parsedTypes.push(type);
        remainingString = remainingString.substring(type.length);
        foundMatch = true;
        break; // Move to next iteration of outer loop
      }
    }
    if (!foundMatch) {
      // Avoid infinite loop if something unexpected is encountered
      // console.warn(`parseTypesString: Could not parse remaining type string: "${remainingString}"`);
      break;
    }
  }
  return parsedTypes;
}

/**
 * Checks if a paragraph node starts with a <code> element, allowing only
 * insignificant whitespace or comment nodes before it.
 * Used to identify paragraphs that list valid values for an argument.
 */
function isCleanValuePrefix(
  $: cheerio.Root,
  paragraphElement: cheerio.Cheerio,
  firstCodeElement: cheerio.Cheerio
): boolean {
  let prefixIsClean = true;
  const contents = paragraphElement.contents();
  const firstCodeNode = firstCodeElement[0];

  for (let i = 0; i < contents.length; i++) {
    const node = contents[i];

    if (node === firstCodeNode) {
      break; // Reached the target code element, prefix is clean so far
    }

    if (node.type === 'tag') { // Found another element before the code tag
      prefixIsClean = false;
      break;
    } else if (node.type === 'text') {
      // Found non-whitespace text before the code tag
      if ($(node).text().trim() !== '') {
        prefixIsClean = false;
        break;
      }
    }
    // Ignore comment nodes
  }
  return prefixIsClean;
}

/**
 * Parses argument details from a Cheerio object representing the arguments div.
 * Extracts name, type, optionality, description, and potential valid values.
 */
function parseArgumentsFromDiv($: cheerio.Root, argsDiv: cheerio.Cheerio | null): NotecardApiArgument[] {
  const argumentsList: NotecardApiArgument[] = [];
  if (!argsDiv || argsDiv.length === 0) {
    return argumentsList;
  }

  // Each argument is typically defined by an h3 followed by paragraphs
  argsDiv.find('h3').each((_, argHeader) => {
    const argH3 = $(argHeader);
    const name = argH3.find('code').text().trim();

    if (name) {
      // Type and optionality are usually in an <em> tag in the first <p> after <h3>
      const descriptionP = argH3.next('p');
      const typeMatch = descriptionP.find('em').text().match(/^(.*?)(?:\s*\((optional|required)\))?$/);
      const type = typeMatch ? typeMatch[1].trim() : null;
      const optional = typeMatch ? typeMatch[2] === 'optional' : false;

      // Start description with text from the first paragraph (minus the type info)
      const initialDescriptionClone = descriptionP.clone();
      initialDescriptionClone.find('em').remove();
      let description = initialDescriptionClone.text().trim();

      const validValues: string[] = [];

      // Process subsequent paragraphs until the next argument header (h3)
      // These might contain more description or list valid values.
      argH3.nextUntil('h3', 'p').each((_, pElement) => {
        const p = $(pElement);
        const firstCode = p.find('code').first();
        let isValueParagraph = false;

        if (firstCode.length > 0) {
          // Check if this paragraph looks like a list item for valid values
          const prefixIsClean = isCleanValuePrefix($, p, firstCode);

          if (prefixIsClean) {
             isValueParagraph = true; // Treat this as a value item, not description
             let value = firstCode.text().trim();
             // Clean up surrounding quotes (e.g., "dfu" -> dfu)
             if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
               value = value.substring(1, value.length - 1);
             }
             if (value && !validValues.includes(value)) {
               validValues.push(value);
             }
          }
        }

        // Append text from paragraphs that aren't the initial one and aren't value listings
        if (p[0] !== descriptionP[0] && !isValueParagraph) {
          description += ' ' + p.text().trim();
        }
      });

      const argumentDetail: NotecardApiArgument = {
        name,
        type,
        optional,
        description: description || null,
        ...(validValues.length > 0 && { validValues }), // Add only if non-empty
      };
      argumentsList.push(argumentDetail);
    }
  });

  return argumentsList;
}

/**
 * Scrapes Notecard API documentation pages to extract API request names,
 * supported Notecard types, and detailed argument information.
 */
export async function scrapeNotecardApis(): Promise<NotecardApiDetail[] | { error: string }> {

  // List of pages to scrape
  const urls = [
    'https://dev.blues.io/api-reference/notecard-api/card-requests/latest',
    'https://dev.blues.io/api-reference/notecard-api/dfu-requests/latest/',
    'https://dev.blues.io/api-reference/notecard-api/env-requests/latest/',
    'https://dev.blues.io/api-reference/notecard-api/file-requests/latest/',
    'https://dev.blues.io/api-reference/notecard-api/hub-requests/latest/',
    'https://dev.blues.io/api-reference/notecard-api/note-requests/latest/',
    'https://dev.blues.io/api-reference/notecard-api/ntn-requests/latest/',
    'https://dev.blues.io/api-reference/notecard-api/web-requests/latest/',
    'https://dev.blues.io/api-reference/notecard-api/var-requests/latest/'
  ];

  const allApiDetailsList: NotecardApiDetail[] = [];
  let totalErrors = 0;

  console.error(`Starting scrape for ${urls.length} pages...`);

  for (const url of urls) {
    console.error(`Scraping page: ${url}...`);
    try {
      const { data: html } = await axios.get<string>(url);
      const $ = cheerio.load(html);
      // Selector targets links like <a href="#card-attn">...</a> which introduce API requests
      const apiSelector = 'a[href^="#"]';
      let foundOnPage = 0;

      $(apiSelector).each((_index: number, element: cheerio.Element) => {
        const fullText = $(element).text().trim();
        // Extract request name (e.g., card.attn) and trailing type badges
        const partsMatch = fullText.match(/^([\w.]+)\s*(.*)$/);

        // Basic validation: check for dot in name and presence of type badges
        if (partsMatch && partsMatch[1] && partsMatch[1].includes('.') && partsMatch[2] && partsMatch[2].trim().length > 0) {
          const requestName = partsMatch[1];
          const typesString = partsMatch[2].trim();
          const parsedTypes = parseTypesString(typesString);

          // --- Find Argument Div ---
          // Strategy: Find the span with the ID matching the href (e.g., #card-attn),
          // then get its parent h2, then find the next sibling div containing ' arguments' in class.
          const href = $(element).attr('href');
          const apiId = href?.substring(1);
          let argsDiv: cheerio.Cheerio | null = null;
          if (apiId) {
            const apiAnchorSpan = $(`#${apiId}`);
            if (apiAnchorSpan.length > 0) {
              const apiHeader = apiAnchorSpan.parent('h2');
              if (apiHeader.length > 0) {
                 argsDiv = apiHeader.nextAll('div[class*=" arguments"]').first();
              } else {
                 // Log error if structure deviates, but continue parsing page
                 console.error(`Could not find parent h2 for span ID #${apiId}`);
              }
            } else {
              console.error(`Could not find api anchor span with ID #${apiId}`);
            }
          }
          // --- End Argument Div Finding Logic ---

          const argumentsList = parseArgumentsFromDiv($, argsDiv);

          // --- Merge/Update Logic ---
          // Check if this API request was already found (e.g., on a different page)
          const existingIndex = allApiDetailsList.findIndex(item => item.request === requestName);

          if (existingIndex === -1) {
            // Add new entry if not found
            allApiDetailsList.push({ request: requestName, types: parsedTypes, arguments: argumentsList });
            foundOnPage++;
          } else {
            // Update existing entry if the current scrape provides missing info
            const existingEntry = allApiDetailsList[existingIndex];
            if (existingEntry.types.length === 0 && parsedTypes.length > 0) {
              existingEntry.types = parsedTypes;
            }
            if (existingEntry.arguments.length === 0 && argumentsList.length > 0) {
              existingEntry.arguments = argumentsList;
            }
          }
          // --- End Merge/Update Logic ---
        }
      });
      console.error(`-> Found ${foundOnPage} new API requests on this page.`);

    } catch (error: any) {
      totalErrors++;
      let errorMsg = `Scraping Error on page ${url}: ${error?.message || 'Unknown error'}`;
      if (error && typeof error === 'object' && 'isAxiosError' in error && error.isAxiosError && error.response) {
        errorMsg += ` (Status Code: ${error.response.status})`;
      }
      console.error(errorMsg); // Log error for the page but continue
    }
  } // End loop through URLs

  console.error(`Finished scraping. Total errors encountered: ${totalErrors}.`);

  if (allApiDetailsList.length > 0) {
    console.error(`Scraping successful. Found ${allApiDetailsList.length} total specific API requests across all pages.`);
    const sortedList = allApiDetailsList.sort((a, b) => a.request.localeCompare(b.request));

    const scriptDir = path.dirname(__filename); // Renamed variable
    const outputDir = path.join(scriptDir, '..', 'dist');
    const outputFile = path.join(outputDir, 'notecard-apis.json');
    try {
      await fs.mkdir(outputDir, { recursive: true });
      const jsonData = JSON.stringify(sortedList, null, 2);
      await fs.writeFile(outputFile, jsonData, 'utf-8');
      console.error(`Successfully wrote API data to ${outputFile}`);
    } catch (writeError: any) {
      console.error(`Error writing API data to file ${outputFile}: ${writeError?.message || 'Unknown write error'}`);
      // Continue execution and return data even if file write fails
    }

    return sortedList;
  } else {
    const errorMsg = `Scraping Error: Could not extract any valid API requests from any of the target pages: ${urls.join(', ')}`;
    console.error(errorMsg);
    return { error: errorMsg };
  }
}