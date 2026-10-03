export interface ConnectedHostCallMethod {
  readonly kind: string;
  readonly route: string;
}

export const AGENT_KNOWLEDGE_METHODS = {
  status: {
    kind: 'agentKnowledge.status',
    route: '/api/goodvibes-agent/knowledge/status',
  },
  ask: {
    kind: 'agentKnowledge.ask',
    route: '/api/goodvibes-agent/knowledge/ask',
  },
  search: {
    kind: 'agentKnowledge.search',
    route: '/api/goodvibes-agent/knowledge/search',
  },
  sourcesList: {
    kind: 'agentKnowledge.sources.list',
    route: '/api/goodvibes-agent/knowledge/sources',
  },
  nodesList: {
    kind: 'agentKnowledge.nodes.list',
    route: '/api/goodvibes-agent/knowledge/nodes',
  },
  issuesList: {
    kind: 'agentKnowledge.issues.list',
    route: '/api/goodvibes-agent/knowledge/issues',
  },
  itemGet: {
    kind: 'agentKnowledge.item.get',
    route: '/api/goodvibes-agent/knowledge/items/{id}',
  },
  map: {
    kind: 'agentKnowledge.map',
    route: '/api/goodvibes-agent/knowledge/map',
  },
  connectorsList: {
    kind: 'agentKnowledge.connectors.list',
    route: '/api/goodvibes-agent/knowledge/connectors',
  },
  connectorGet: {
    kind: 'agentKnowledge.connector.get',
    route: '/api/goodvibes-agent/knowledge/connectors/{id}',
  },
  connectorDoctor: {
    kind: 'agentKnowledge.connector.doctor',
    route: '/api/goodvibes-agent/knowledge/connectors/{id}/doctor',
  },
  ingestUrl: {
    kind: 'agentKnowledge.ingest.url',
    route: '/api/goodvibes-agent/knowledge/ingest/url',
  },
  ingestArtifact: {
    kind: 'agentKnowledge.ingest.artifact',
    route: '/api/goodvibes-agent/knowledge/ingest/artifact',
  },
  ingestUrls: {
    kind: 'agentKnowledge.ingest.urls',
    route: '/api/goodvibes-agent/knowledge/ingest/urls',
  },
  ingestBookmarks: {
    kind: 'agentKnowledge.ingest.bookmarks',
    route: '/api/goodvibes-agent/knowledge/ingest/bookmarks',
  },
  ingestBrowserHistory: {
    kind: 'agentKnowledge.ingest.browserHistory',
    route: '/api/goodvibes-agent/knowledge/ingest/browser-history',
  },
  ingestConnector: {
    kind: 'agentKnowledge.ingest.connector',
    route: '/api/goodvibes-agent/knowledge/ingest/connector',
  },
  reindex: {
    kind: 'agentKnowledge.reindex',
    route: '/api/goodvibes-agent/knowledge/reindex',
  },
} as const;

export const DELEGATION_METHOD = {
  kind: 'sessions.messages.create',
  route: 'sessions.messages.create',
} as const;
