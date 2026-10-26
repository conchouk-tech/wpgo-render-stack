import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentGuidanceForAbility,
  enrichAbilitySchema,
  nearestCommand,
  normalizeManifest,
  preflightAbility,
  summarizeApproval
} from './agent-experience.js';

const manifest = {
  commands: {
    read: ['post.list', 'post.get', 'menu.list'],
    write: ['post.create', 'post.update', 'menu.add-post', 'menu.assign-location']
  },
  recipes: ['clone-to-draft', 'purge-and-refresh']
};

test('normalizes live platform manifest', () => {
  assert.deepEqual(normalizeManifest(manifest), {
    read: ['post.list', 'post.get', 'menu.list'],
    write: ['post.create', 'post.update', 'menu.add-post', 'menu.assign-location'],
    recipes: ['clone-to-draft', 'purge-and-refresh']
  });
});

test('suggests valid menu command for Claude regression typo', () => {
  assert.equal(nearestCommand('menu.item.add', manifest.commands.write), 'menu.add-post');
});

test('rejects unknown command before approval with a 400-style result', () => {
  const result = preflightAbility('wpgo/command-write', { command: 'menu.item.add', args: {} }, manifest);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'wpgo_command_unknown');
  assert.equal(result.suggestion, 'menu.add-post');
});

test('rejects invalid job step before a plan approval is raised', () => {
  const result = preflightAbility('wpgo/create-job', {
    steps: [
      { command: 'post.create', args: { title: 'One' } },
      { command: 'menu.item.add', args: {} }
    ]
  }, manifest);
  assert.equal(result.ok, false);
  assert.match(result.message, /steps\[1\]\.command/);
});

test('enriches command-write schema with live enum', () => {
  const schema = {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1 },
      args: { type: 'object', additionalProperties: true }
    },
    required: ['command']
  };
  const enriched = enrichAbilitySchema('wpgo/command-write', schema, manifest);
  assert.deepEqual(enriched.properties.command.enum, manifest.commands.write);
});

test('enriches create-job step commands and explains plan approval', () => {
  const schema = {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            args: { type: 'object' }
          }
        }
      }
    }
  };
  const enriched = enrichAbilitySchema('wpgo/create-job', schema, manifest);
  assert.deepEqual(enriched.properties.steps.items.properties.command.enum, [
    'post.list', 'post.get', 'menu.list', 'post.create', 'post.update', 'menu.add-post', 'menu.assign-location'
  ]);
  assert.match(enriched.properties.steps.description, /approve the exact plan once/i);
  assert.match(agentGuidanceForAbility('wpgo/create-job'), /one approval/i);
});

test('produces human-readable plan summary', () => {
  const summary = summarizeApproval('wpgo/create-job', {
    steps: [
      { command: 'post.create', args: { title: 'Beneath The Wire' } },
      { command: 'post.create', args: { title: 'Characters' } },
      { command: 'menu.add-post', args: { title: 'The Books' } }
    ]
  });
  assert.match(summary, /3 steps/);
  assert.match(summary, /2 × post\.create/);
  assert.match(summary, /Beneath The Wire/);
  assert.match(summary, /1 × menu\.add-post/);
});
