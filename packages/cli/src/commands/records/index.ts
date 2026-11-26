export {
  RECORD_COMMAND_ALIASES,
  RECORD_COMMAND_CATEGORIES,
  RECORD_COMMAND_SPECS,
  isRecordCommand,
  resolveRecordCommand,
  type AssetScriptCommandSpec,
  type BaseRecordCommandSpec,
  type RecordCommandCategory,
  type RecordCommandCategoryInfo,
  type RecordCommandSpec,
  type SkillGuideCommandSpec,
  type SkillScriptCommandSpec,
} from './registry.js';

export {
  resolveRecordGuidePath,
  resolveRecordScriptPath,
  type ResolveRootsOptions,
} from './resolve.js';

export {
  classifyRecordCommandIntent,
  formatRecordCommandsHelp,
  parseSkillDocument,
  renderRecordCommandHelp,
  rewriteSkillCommandExamples,
  type ParsedSkillDocument,
  type RecordCommandIntent,
} from './help.js';

export {
  resolveScriptInvocation,
  runRecordCommand,
  type RecordSpawnFn,
  type RunRecordCommandOptions,
  type RunRecordCommandResult,
  type ScriptInvocation,
} from './runner.js';
