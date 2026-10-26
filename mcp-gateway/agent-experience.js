const EMPTY_MANIFEST = Object.freeze({ read: [], write: [], recipes: [] });

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
}

export function normalizeManifest(raw) {
  const source = raw?.result && typeof raw.result === 'object' ? raw.result : raw;
  const commands = source?.commands && typeof source.commands === 'object' ? source.commands : {};
  return {
    read: uniqueStrings(commands.read),
    write: uniqueStrings(commands.write),
    recipes: uniqueStrings(source?.recipes)
  };
}

export function editDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      previous = saved;
    }
  }
  return row[right.length];
}

export function nearestCommand(input, candidates) {
  const needle = String(input || '').trim();
  const list = uniqueStrings(candidates);
  if (!needle || !list.length) return '';
  let best = '';
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of list) {
    const distance = editDistance(needle, candidate);
    const prefixBonus = candidate.split('.').at(0) === needle.split('.').at(0) ? -0.75 : 0;
    const score = distance + prefixBonus;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  const threshold = Math.max(3, Math.ceil(needle.length * 0.45));
  return bestScore <= threshold ? best : '';
}

function commandError(command, validCommands, path = 'command') {
  const suggestion = nearestCommand(command, validCommands);
  return {
    ok: false,
    status: 400,
    code: 'wpgo_command_unknown',
    message: suggestion
      ? `Unknown WPGo command "${command}" at ${path}. Did you mean "${suggestion}"?`
      : `Unknown WPGo command "${command}" at ${path}.`,
    suggestion,
    valid_commands: validCommands
  };
}

function recipeName(input) {
  return String(input?.recipe ?? input?.name ?? '').trim();
}

export function preflightAbility(abilityName, input, manifest = EMPTY_MANIFEST) {
  const normalized = normalizeManifest(manifest);
  const body = input && typeof input === 'object' ? input : {};

  if (abilityName === 'wpgo/command-read') {
    const command = String(body.command || '').trim();
    if (!normalized.read.includes(command)) return commandError(command, normalized.read);
  }

  if (abilityName === 'wpgo/command-write') {
    const command = String(body.command || '').trim();
    if (!normalized.write.includes(command)) return commandError(command, normalized.write);
  }

  if (abilityName === 'wpgo/create-job') {
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const validCommands = uniqueStrings([...normalized.read, ...normalized.write]);
    for (let index = 0; index < steps.length; index += 1) {
      const command = String(steps[index]?.command || '').trim();
      if (!validCommands.includes(command)) {
        return commandError(command, validCommands, `steps[${index}].command`);
      }
    }
  }

  if (abilityName === 'wpgo/run-recipe' && normalized.recipes.length) {
    const recipe = recipeName(body);
    if (!normalized.recipes.includes(recipe)) {
      const suggestion = nearestCommand(recipe, normalized.recipes);
      return {
        ok: false,
        status: 400,
        code: 'wpgo_recipe_unknown',
        message: suggestion
          ? `Unknown WPGo recipe "${recipe}". Did you mean "${suggestion}"?`
          : `Unknown WPGo recipe "${recipe}".`,
        suggestion,
        valid_recipes: normalized.recipes
      };
    }
  }

  return { ok: true };
}

function setCommandEnum(schema, commands) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  if (!schema.properties || typeof schema.properties !== 'object') return;
  if (!schema.properties.command || typeof schema.properties.command !== 'object') return;
  if (!commands.length) return;
  schema.properties.command.enum = commands;
  schema.properties.command.description = `Supported WPGo command. Choose exactly one of the enumerated values; do not invent command names.`;
}

export function enrichAbilitySchema(abilityName, schema, manifest = EMPTY_MANIFEST) {
  const normalized = normalizeManifest(manifest);
  const output = structuredClone(schema || {});

  if (abilityName === 'wpgo/command-read') {
    setCommandEnum(output, normalized.read);
  } else if (abilityName === 'wpgo/command-write') {
    setCommandEnum(output, normalized.write);
  } else if (abilityName === 'wpgo/create-job') {
    const stepSchema = output?.properties?.steps?.items;
    setCommandEnum(stepSchema, uniqueStrings([...normalized.read, ...normalized.write]));
    if (output?.properties?.steps) {
      output.properties.steps.description = 'Exact preflighted WPGo plan steps. Prefer one create-job for two or more related changes so the user can approve the exact plan once rather than approving each low-risk step separately.';
    }
  } else if (abilityName === 'wpgo/run-recipe' && normalized.recipes.length) {
    const properties = output?.properties;
    const field = properties?.recipe ? 'recipe' : (properties?.name ? 'name' : '');
    if (field) {
      properties[field].enum = normalized.recipes;
      properties[field].description = 'Supported WPGo recipe. Choose exactly one enumerated recipe.';
    }
  }

  return output;
}

function titleForPostStep(step) {
  const args = step?.args && typeof step.args === 'object' ? step.args : {};
  return String(args.title || args.post_title || args.name || args.slug || '').trim();
}

function summarizeSteps(steps) {
  const groups = new Map();
  for (const step of steps) {
    const command = String(step?.command || 'unknown');
    const entry = groups.get(command) || { count: 0, examples: [] };
    entry.count += 1;
    const example = titleForPostStep(step);
    if (example && entry.examples.length < 3) entry.examples.push(example);
    groups.set(command, entry);
  }
  const lines = [];
  for (const [command, info] of groups) {
    const examples = info.examples.length ? ` (${info.examples.join(', ')}${info.count > info.examples.length ? ', …' : ''})` : '';
    lines.push(`${info.count} × ${command}${examples}`);
  }
  return lines;
}

export function summarizeApproval(abilityName, input) {
  const body = input && typeof input === 'object' ? input : {};

  if (abilityName === 'wpgo/create-job') {
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const details = summarizeSteps(steps);
    const headline = `Run an exact WPGo plan containing ${steps.length} step${steps.length === 1 ? '' : 's'}`;
    return details.length ? `${headline}: ${details.join('; ')}` : headline;
  }

  if (abilityName === 'wpgo/command-write') {
    const command = String(body.command || 'write');
    const subject = titleForPostStep(body) || titleForPostStep({ args: body.args });
    return `Run WordPress command ${command}${subject ? ` for ${subject}` : ''}`;
  }

  const labels = {
    'wpgo/update-content-workflow': 'Update WordPress content',
    'wpgo/managed-css-publish': 'Publish a versioned managed CSS revision',
    'wpgo/set-kadence-page-meta': 'Update safe Kadence page settings',
    'wpgo/elementor-edit': 'Edit Elementor content',
    'wpgo/structured-builder-node-edit': 'Edit one structured builder node',
    'wpgo/structured-builder-batch-edit': 'Apply a structured builder edit plan'
  };
  return labels[abilityName] || `Run ${abilityName}`;
}

export function agentGuidanceForAbility(abilityName) {
  if (abilityName === 'wpgo/create-job') {
    return ' Prefer this tool for two or more related safe WordPress changes. WPGo preflights every command first, then one approval can cover the exact payload-bound plan.';
  }
  if (abilityName === 'wpgo/command-write') {
    return ' The command field is restricted to WPGo’s live manifest. Never guess a command name; choose an enumerated value.';
  }
  if (abilityName === 'wpgo/command-read') {
    return ' The command field is restricted to WPGo’s live manifest. Never guess a command name; choose an enumerated value.';
  }
  return '';
}
