/** Source-defined schema conditions shared by the full validator and its closed empty-authority read plan. */
type Column = readonly [name: string, type: 'TEXT' | 'INTEGER', required: 0 | 1, primary: number];
function columns<const T extends readonly Column[]>(value: T): Readonly<T> {
  for (const column of value) Object.freeze(column);
  return Object.freeze(value);
}
export const knowledgeSchemaColumns = Object.freeze({
  workLedger: columns([
    ['project_id', 'TEXT', 1, 1],
    ['format_version', 'INTEGER', 1, 0],
    ['revision', 'INTEGER', 1, 0],
    ['state_json', 'TEXT', 1, 0],
  ] as const),
  execution: columns([
    ['project_id', 'TEXT', 1, 1],
    ['key_hash', 'TEXT', 1, 2],
    ['format_version', 'INTEGER', 1, 0],
    ['state_json', 'TEXT', 1, 0],
    ['attempt_id', 'TEXT', 1, 0],
  ] as const),
  intent: columns([
    ['project_id', 'TEXT', 1, 1],
    ['attempt_id', 'TEXT', 1, 2],
    ['format_version', 'INTEGER', 1, 0],
    ['state_json', 'TEXT', 1, 0],
  ] as const),
  conversation: columns([
    ['project_id', 'TEXT', 1, 1],
    ['principal_id', 'TEXT', 1, 2],
    ['input_id', 'TEXT', 1, 3],
    ['request_id', 'TEXT', 1, 0],
    ['format_version', 'INTEGER', 1, 0],
    ['state_json', 'TEXT', 1, 0],
  ] as const),
  settlement: columns([
    ['project_id', 'TEXT', 1, 1],
    ['key_hash', 'TEXT', 1, 2],
    ['format_version', 'INTEGER', 1, 0],
    ['state_json', 'TEXT', 1, 0],
  ] as const),
  continuation: columns([
    ['project_id', 'TEXT', 1, 1],
    ['continuation_id', 'TEXT', 1, 2],
    ['format_version', 'INTEGER', 1, 0],
    ['state_json', 'TEXT', 1, 0],
  ] as const),
  edgeChange: columns([
    ['sequence', 'INTEGER', 0, 1],
    ['edge_id', 'TEXT', 1, 0],
    ['from_kind', 'TEXT', 1, 0],
    ['from_id', 'TEXT', 1, 0],
    ['to_kind', 'TEXT', 1, 0],
    ['to_id', 'TEXT', 1, 0],
  ] as const),
});
export const executionAttemptColumns = Object.freeze(['project_id', 'attempt_id'] as const);
export const conversationRequestColumns = Object.freeze(['project_id', 'principal_id', 'request_id'] as const);

const edgeChangeTriggers = [
  ['knowledge_edge_change_insert', `CREATE TRIGGER IF NOT EXISTS knowledge_edge_change_insert AFTER INSERT ON knowledge_edges BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(NEW.id,NEW.from_kind,NEW.from_id,NEW.to_kind,NEW.to_id);
  END`],
  ['knowledge_edge_change_delete', `CREATE TRIGGER IF NOT EXISTS knowledge_edge_change_delete AFTER DELETE ON knowledge_edges BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(OLD.id,OLD.from_kind,OLD.from_id,OLD.to_kind,OLD.to_id);
  END`],
  ['knowledge_edge_change_update', `CREATE TRIGGER IF NOT EXISTS knowledge_edge_change_update AFTER UPDATE ON knowledge_edges BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(OLD.id,OLD.from_kind,OLD.from_id,OLD.to_kind,OLD.to_id);
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(NEW.id,NEW.from_kind,NEW.from_id,NEW.to_kind,NEW.to_id);
  END`],
] as const;
for (const entry of edgeChangeTriggers) Object.freeze(entry);
export const knowledgeEdgeChangeTriggers = Object.freeze(edgeChangeTriggers);
