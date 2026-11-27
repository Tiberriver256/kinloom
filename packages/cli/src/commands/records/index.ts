export {
  buildTelemetrySubcmd,
  type RunRecordCommandOptions,
  type RunRecordCommandResult,
  runRecordCommand,
} from './dispatch.js';
export {
  classifyRecordCommandIntent,
  formatRecordCommandsHelp,
  type RecordCommandIntent,
  renderRecordCommandHelp,
} from './help.js';
export {
  type BaseRecordCommandSpec,
  type GuideOnlyCommandSpec,
  isRecordCommand,
  type NativeRecordCommandSpec,
  RECORD_COMMAND_ALIASES,
  RECORD_COMMAND_CATEGORIES,
  RECORD_COMMAND_SPECS,
  type RecordCommandCategory,
  type RecordCommandCategoryInfo,
  type RecordCommandSpec,
  resolveRecordCommand,
} from './registry.js';
export * from './runtime/index.js';
