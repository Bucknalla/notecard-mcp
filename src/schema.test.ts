import { validateNotecardRequest } from './schema';

// Increase timeout for tests that might fetch schemas
jest.setTimeout(30000); // 30 seconds

describe('validateNotecardRequest', () => {
  it('should validate a correct card.version request', async () => {
    const requestJson = '{"req":"card.version"}';
    const result = await validateNotecardRequest(requestJson);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('should invalidate a request missing the req field', async () => {
    const requestJson = '{"file":"data.qo"}'; // Missing 'req'
    const result = await validateNotecardRequest(requestJson);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    // More specific error checking could be added here if needed
    // e.g., expect(result.errors?.[0]?.message).toContain('required property');
  });

  it('should invalidate a request with incorrect parameter type', async () => {
    // hub.set requires mode to be a string, not boolean
    const requestJson = '{"req":"hub.set","mode":true,"product":"test"}';
    const result = await validateNotecardRequest(requestJson);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.instancePath === '/mode' && e.message?.includes('string'))).toBe(true);
  });

  it('should invalidate a request with an unknown req type', async () => {
    const requestJson = '{"req":"card.unknown"}';
    const result = await validateNotecardRequest(requestJson);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    // This checks if Ajv reported a failure to match any of the 'oneOf' schemas
    expect(result.errors?.some(e => e.keyword === 'oneOf')).toBe(true);
  });

  it('should return an error for invalid JSON input', async () => {
    const requestJson = '{"req":"card.version",}'; // Trailing comma
    const result = await validateNotecardRequest(requestJson);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toContain('Invalid JSON');
  });

  it('should validate a correct hub.set request', async () => {
    const requestJson = '{"req":"hub.set","mode":"continuous","product":"com.blues.alex:test"}';
    const result = await validateNotecardRequest(requestJson);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  // Note: By default (with strict: false), Ajv allows additional properties.
  // A test for strictness could be added if that behavior is changed.
  it('should validate a request with additional properties (default behavior)', async () => {
    const requestJson = '{"req":"card.version","extraField":123}';
    const result = await validateNotecardRequest(requestJson);
    expect(result.valid).toBe(true); // Should be valid unless strictness is enforced differently
    expect(result.errors).toBeUndefined();
  });
});

// Ensure newline at the end of the file 