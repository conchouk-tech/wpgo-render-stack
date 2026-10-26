import test from 'node:test';
import assert from 'node:assert/strict';
import { repairAndValidateJsonSchema, repairJsonSchema, validateJsonSchema } from './schema-guard.js';

test('repairs PHP empty-array schemas used as arbitrary value nodes', () => {
  const input = {
    type: 'object',
    properties: {
      value: [],
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { value: [] }
        }
      }
    }
  };
  const repaired = repairAndValidateJsonSchema(input);
  assert.deepEqual(repaired.properties.value, {});
  assert.deepEqual(repaired.properties.edits.items.properties.value, {});
});

test('does not rewrite normal array-valued JSON Schema keywords', () => {
  const input = {
    type: 'object',
    required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['set-value', 'replace-text'] },
      nullable: { type: ['string', 'null'] }
    }
  };
  const repaired = repairJsonSchema(input);
  assert.deepEqual(repaired.required, ['operation']);
  assert.deepEqual(repaired.properties.operation.enum, ['set-value', 'replace-text']);
  assert.deepEqual(repaired.properties.nullable.type, ['string', 'null']);
});

test('validator rejects malformed child schema before repair', () => {
  const validation = validateJsonSchema({ type: 'object', properties: { value: [] } });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /properties\.value/);
});

test('exact Claude builder-schema regression is accepted after repair', () => {
  const nodeEdit = {
    type: 'object',
    properties: {
      post_id: { type: 'integer', minimum: 1 },
      path: { type: 'array', items: { type: ['string', 'integer'] } },
      operation: { type: 'string', enum: ['set-value', 'replace-text'] },
      value: [],
      old_text: { type: 'string' },
      new_text: { type: 'string' }
    },
    required: ['post_id', 'path', 'operation']
  };
  const repaired = repairAndValidateJsonSchema(nodeEdit);
  assert.equal(validateJsonSchema(repaired).ok, true);
  assert.deepEqual(repaired.properties.value, {});
});
