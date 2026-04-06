#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');

function parseArgs(argv) {
  const options = {
    inputDir: path.join(os.homedir(), '.codex', 'archived_sessions'),
    outputDir: path.join(projectDir, 'generated', 'archived_sessions_md'),
    includeTools: true,
    includeInstructions: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--input-dir') {
      options.inputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      options.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--no-tools') {
      options.includeTools = false;
      continue;
    }

    if (arg === '--include-instructions') {
      options.includeInstructions = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/export-codex-archives.mjs [options]

Options:
  --input-dir <path>            Source directory with archived session .jsonl files
  --output-dir <path>           Destination directory for generated .md files
  --no-tools                    Skip tool call / tool output sections
  --include-instructions        Include non-user/non-assistant messages
  -h, --help                    Show this help
`);
}

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function flattenContent(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      if (typeof item.text === 'string') {
        return item.text;
      }

      if (typeof item.content === 'string') {
        return item.content;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function shouldSkipMessage(role, text, includeInstructions) {
  if (!includeInstructions && !['user', 'assistant'].includes(role)) {
    return true;
  }

  const trimmed = text.trim();

  if (!trimmed) {
    return true;
  }

  if (role === 'user' && /^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) {
    return true;
  }

  return false;
}

function renderFence(text) {
  return `~~~text\n${text.replace(/\r\n/g, '\n')}\n~~~`;
}

function renderToolEntry(entry) {
  const parts = [
    `### ${entry.kind}`,
    `- Timestamp: ${entry.timestamp ?? 'unknown'}`,
  ];

  if (entry.name) {
    parts.push(`- Name: \`${entry.name}\``);
  }

  if (entry.callId) {
    parts.push(`- Call ID: \`${entry.callId}\``);
  }

  if (entry.body) {
    parts.push('', renderFence(entry.body));
  }

  return parts.join('\n');
}

function renderMarkdown(session) {
  const lines = [
    `# Archived Session ${session.id ?? session.sourceName}`,
    '',
    `- Source JSONL: \`${session.sourcePath}\``,
    `- Session ID: \`${session.id ?? 'unknown'}\``,
    `- Started At: ${session.startedAt ?? 'unknown'}`,
    `- CWD: \`${session.cwd ?? 'unknown'}\``,
    `- Source: ${session.source ?? 'unknown'}`,
    `- Model Provider: ${session.modelProvider ?? 'unknown'}`,
    '',
    '## Conversation',
    '',
  ];

  if (session.messages.length === 0) {
    lines.push('_No conversation messages were extracted._', '');
  } else {
    session.messages.forEach((message, index) => {
      lines.push(`### ${index + 1}. ${message.role === 'assistant' ? 'Assistant' : 'User'}`);
      lines.push(`- Timestamp: ${message.timestamp ?? 'unknown'}`);

      if (message.phase) {
        lines.push(`- Phase: ${message.phase}`);
      }

      lines.push('');
      lines.push(renderFence(message.text));
      lines.push('');
    });
  }

  if (session.toolEntries.length > 0) {
    lines.push('## Tool Activity', '');

    session.toolEntries.forEach((entry) => {
      lines.push(renderToolEntry(entry), '');
    });
  }

  return lines.join('\n').trimEnd() + '\n';
}

async function parseSessionFile(filePath, options) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const session = {
    sourceName: path.basename(filePath, '.jsonl'),
    sourcePath: filePath,
    id: null,
    startedAt: null,
    cwd: null,
    source: null,
    modelProvider: null,
    messages: [],
    toolEntries: [],
  };

  for (const line of lines) {
    let record;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === 'session_meta') {
      const payload = record.payload ?? {};
      session.id = payload.id ?? session.id;
      session.startedAt = payload.timestamp ?? session.startedAt;
      session.cwd = payload.cwd ?? session.cwd;
      session.source = payload.source ?? session.source;
      session.modelProvider = payload.model_provider ?? session.modelProvider;
      continue;
    }

    if (record.type !== 'response_item') {
      continue;
    }

    const payload = record.payload ?? {};

    if (payload.type === 'message') {
      const role = safeText(payload.role);
      const text = flattenContent(payload.content);

      if (shouldSkipMessage(role, text, options.includeInstructions)) {
        continue;
      }

      session.messages.push({
        timestamp: record.timestamp,
        role,
        phase: safeText(payload.phase) || null,
        text,
      });
      continue;
    }

    if (!options.includeTools) {
      continue;
    }

    if (payload.type === 'function_call') {
      session.toolEntries.push({
        kind: 'Tool Call',
        timestamp: record.timestamp,
        name: safeText(payload.name),
        callId: safeText(payload.call_id),
        body: safeText(payload.arguments),
      });
      continue;
    }

    if (payload.type === 'function_call_output') {
      session.toolEntries.push({
        kind: 'Tool Output',
        timestamp: record.timestamp,
        name: '',
        callId: safeText(payload.call_id),
        body: safeText(payload.output),
      });
    }
  }

  return session;
}

async function writeIndex(summaries, outputDir) {
  const lines = [
    '# Archived Sessions Export',
    '',
    `- Exported At: ${new Date().toISOString()}`,
    `- Session Count: ${summaries.length}`,
    '',
    '## Files',
    '',
  ];

  for (const summary of summaries) {
    lines.push(
      `- \`${summary.fileName}\` | messages: ${summary.messageCount} | tools: ${summary.toolCount} | session: \`${summary.sessionId}\``
    );
  }

  lines.push('');
  await fs.writeFile(path.join(outputDir, 'README.md'), lines.join('\n'), 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dirEntries = await fs.readdir(options.inputDir, { withFileTypes: true });
  const files = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(options.inputDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  await fs.mkdir(options.outputDir, { recursive: true });

  const summaries = [];

  for (const filePath of files) {
    const session = await parseSessionFile(filePath, options);
    const outputName = `${path.basename(filePath, '.jsonl')}.md`;
    const outputPath = path.join(options.outputDir, outputName);
    const markdown = renderMarkdown(session);

    await fs.writeFile(outputPath, markdown, 'utf8');

    summaries.push({
      fileName: outputName,
      messageCount: session.messages.length,
      toolCount: session.toolEntries.length,
      sessionId: session.id ?? 'unknown',
    });
  }

  await writeIndex(summaries, options.outputDir);

  console.log(`Exported ${summaries.length} archived sessions to ${options.outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
