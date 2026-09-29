import { mkdir, writeFile } from 'node:fs/promises';
import { outputSchema } from '../src/domain.js';
import { openApiDocument } from '../src/openapi.js';
await mkdir('docs', { recursive: true });
await writeFile('docs/openapi.json', `${JSON.stringify(openApiDocument, null, 2)}\n`);
await writeFile('docs/shipment.schema.json', `${JSON.stringify(outputSchema, null, 2)}\n`);
