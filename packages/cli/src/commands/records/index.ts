export {
  RECORD_COMMAND_ALIASES,
  RECORD_COMMAND_CATEGORIES,
  RECORD_COMMAND_SPECS,
  isRecordCommand,
  resolveRecordCommand,
  type AssetScriptCommandSpec,
  type BaseRecordCommandSpec,
  type NativeRecordCommandSpec,
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
  runRecordCommand,
  type RunRecordCommandOptions,
  type RunRecordCommandResult,
} from './dispatch.js';

export {
  buildTelemetrySubcmd,
  isUvOfflineCacheMiss,
  resolveScriptInvocation,
  type RecordSpawnFn,
  type ScriptInvocation,
} from './runner.js';

export * from './runtime/index.js';
