import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFragmentRouter, TABS, type TabFragment, type AdminDeps } from './admin-tab-fragments';
import Database from 'better-sqlite3';

vi.mock('../db/app-settings', () => ({
  getAppSetting: vi.fn(() => null),
}));

vi.mock('../db/cascade-delete', () => ({
  getDbWideSoftDeleteCounts: vi.fn(() => ({
    channels: 0, signals: 0, mentions: 0, chats: 0, progress: 0,
  })),
}));

vi.mock('../db/poll-runs', () => ({
  queryPollRuns: vi.fn(() => ({ items: [], total: 0 })),
}));

describe('admin-tab-fragments', () => {
  describe('TABS config', () => {
    it('should have exactly 4 tab fragments', () => {
      expect(TABS).toHaveLength(4);
    });

    it('should have overview, channels, topics, and settings tabs', () => {
      const keys = TABS.map((t) => t.key);
      expect(keys).toEqual(['overview', 'channels', 'topics', 'settings']);
    });

    it('should map each tab to the correct partial', () => {
      const tabMap = Object.fromEntries(TABS.map((t) => [t.key, t.partial]));
      expect(tabMap).toEqual({
        overview: 'admin/_overviewTab',
        channels: 'admin/_channelsTab',
        topics: 'admin/_topicsTab',
        settings: 'admin/_settingsTab',
      });
    });

    it('should have a dataFn for each tab', () => {
      for (const tab of TABS) {
        expect(typeof tab.dataFn).toBe('function');
      }
    });
  });

  describe('createFragmentRouter', () => {
    let deps: any;
    let rendered: { partial: string; locals: Record<string, unknown> }[];

    beforeEach(() => {
      const mockChannelManager = {
        listAll: vi.fn(() => [
          { channel_id: 'UC123', display_name: 'Test Channel', active: true },
        ]),
      };
      const mockTopicManager = {
        listWithCounts: vi.fn(() => [
          { id: 1, short_name: 'MTG', key: 'mtg' },
        ]),
      };
      const mockPollRunManager = {
        progress: vi.fn(() => ({
          runId: 1,
          state: { status: 'idle' as const },
        })),
      };
      const mockDb = {
        prepare: vi.fn(() => ({
          get: vi.fn(() => ({ summarized: 0, pending: 0 })),
          all: vi.fn(() => []),
        })),
      } as unknown as Database.Database;

      deps = {
        channelManager: mockChannelManager as any,
        topicManager: mockTopicManager as any,
        pollRunManager: mockPollRunManager as any,
        db: mockDb,
      };

      // Reset render tracking before each test
      rendered = [];
    });

    it('should return an express Router', () => {
      const router = createFragmentRouter(deps);
      expect(router).toBeDefined();
    });

    it('should register GET routes for all 4 tab fragments', () => {
      const router = createFragmentRouter(deps);
      // Express routers stack routes; we can inspect the stack
      const routes = (router as any).stack.map((s: any) => s.route);
      const definedPaths = routes.filter((r: any) => r !== undefined).map((r: any) => r.path);
      
      expect(definedPaths).toContain('/admin/overview-fragment');
      expect(definedPaths).toContain('/admin/channels-fragment');
      expect(definedPaths).toContain('/admin/topics-fragment');
      expect(definedPaths).toContain('/admin/settings-fragment');
    });

    it('should render overview partial with layout:false on GET /admin/overview-fragment', async () => {
      const router = createFragmentRouter(deps);
      
      // Create a mock request/response pair
      const mockRes = {
        render: vi.fn(),
      };
      
      const stackItem = (router as any).stack.find(
        (s: any) => s.route?.path === '/admin/overview-fragment'
      );
      expect(stackItem).toBeDefined();

      const handler = stackItem.route.stack[0].handle;
      handler({}, mockRes);

      expect(mockRes.render).toHaveBeenCalledWith('admin/_overviewTab', 
        expect.objectContaining({ layout: false }));
    });

    it('should render channels partial with layout:false on GET /admin/channels-fragment', async () => {
      const router = createFragmentRouter(deps);
      
      // Create a mock request/response pair
      const mockRes = {
        render: vi.fn(),
      };
      
      // Find and invoke the route handler
      const stackItem = (router as any).stack.find(
        (s: any) => s.route?.path === '/admin/channels-fragment'
      );
      expect(stackItem).toBeDefined();

      const handler = stackItem.route.stack[0].handle;
      handler({}, mockRes);

      expect(mockRes.render).toHaveBeenCalledWith('admin/_channelsTab', 
        expect.objectContaining({ layout: false }));
    });

    it('should render topics partial with layout:false on GET /admin/topics-fragment', async () => {
      const router = createFragmentRouter(deps);
      
      const mockRes = {
        render: vi.fn(),
      };
      
      const stackItem = (router as any).stack.find(
        (s: any) => s.route?.path === '/admin/topics-fragment'
      );
      expect(stackItem).toBeDefined();

      const handler = stackItem.route.stack[0].handle;
      handler({}, mockRes);

      expect(mockRes.render).toHaveBeenCalledWith('admin/_topicsTab', 
        expect.objectContaining({ layout: false }));
    });

    it('should render settings partial with layout:false on GET /admin/settings-fragment', async () => {
      const router = createFragmentRouter(deps);
      
      const mockRes = {
        render: vi.fn(),
      };
      
      const stackItem = (router as any).stack.find(
        (s: any) => s.route?.path === '/admin/settings-fragment'
      );
      expect(stackItem).toBeDefined();

      const handler = stackItem.route.stack[0].handle;
      handler({}, mockRes);

      expect(mockRes.render).toHaveBeenCalledWith('admin/_settingsTab', 
        expect.objectContaining({ layout: false }));
    });

    it('should pass tab-specific data from dataFn to the partial', async () => {
      const router = createFragmentRouter(deps);
      
      const mockRes = {
        render: vi.fn(),
      };
      
      // Invoke channels fragment handler
      const stackItem = (router as any).stack.find(
        (s: any) => s.route?.path === '/admin/channels-fragment'
      );
      const handler = stackItem.route.stack[0].handle;
      handler({}, mockRes);

      expect(mockRes.render).toHaveBeenCalledWith('admin/_channelsTab', 
        expect.objectContaining({
          layout: false,
          channels: expect.any(Array),
          topics: expect.any(Array),
        }));
    });
  });

  describe('tab dataFn behavior', () => {
    it('channels dataFn should return channels and topics from managers', () => {
      const channelsTab = TABS.find((t) => t.key === 'channels')!;
      
      const deps: AdminDeps = {
        channelManager: { listAll: vi.fn(() => [{ id: 1 }]) } as any,
        topicManager: { listWithCounts: vi.fn(() => [{ id: 2 }]) } as any,
        pollRunManager: {} as any,
        db: {} as any,
      };

      const data = channelsTab.dataFn(deps);
      expect(data.channels).toEqual([{ id: 1 }]);
      expect(data.topics).toEqual([{ id: 2 }]);
    });

    it('topics dataFn should return topics from topicManager', () => {
      const topicsTab = TABS.find((t) => t.key === 'topics')!;
      
      const deps: AdminDeps = {
        channelManager: {} as any,
        topicManager: { listWithCounts: vi.fn(() => [{ id: 1 }]) } as any,
        pollRunManager: {} as any,
        db: {} as any,
      };

      const data = topicsTab.dataFn(deps);
      expect(data.topics).toEqual([{ id: 1 }]);
    });

    it('overview dataFn should return counts, recentRuns, and currentRunState', () => {
      const overviewTab = TABS.find((t) => t.key === 'overview')!;

      const deps: AdminDeps = {
        channelManager: { listAll: vi.fn(() => [{ id: 1, active: 1, topic_id: 1 }, { id: 2, active: 1, topic_id: null }]) } as any,
        topicManager: { listWithCounts: vi.fn(() => [{ id: 1 }, { id: 2 }]) } as any,
        pollRunManager: {
          progress: vi.fn(() => ({
            runId: 1,
            state: { status: 'idle' as const },
          })),
        } as any,
        db: {
          prepare: vi.fn(() => ({
            all: vi.fn(() => []),
            get: vi.fn(() => ({ summarized: 5, pending: 2 })),
          })),
        } as any,
      };

      const data = overviewTab.dataFn(deps);
      expect(data).toHaveProperty('recentRuns');
      expect(data).toHaveProperty('currentRunState');
      expect(data).toHaveProperty('counts');
    });

    it('settings dataFn should return defaultPrompt and softDeleteCounts', () => {
      const settingsTab = TABS.find((t) => t.key === 'settings')!;

      const deps: AdminDeps = {
        channelManager: {} as any,
        topicManager: {} as any,
        pollRunManager: {} as any,
        db: {} as any,
      };

      const data = settingsTab.dataFn(deps);
      expect(data).toHaveProperty('defaultPrompt');
      expect(data).toHaveProperty('softDeleteCounts');
      expect(data).toHaveProperty('softDeleteTotal');
    });

    it('polling dataFn should return state only when running', () => {
      // polling tab no longer exists — verify overview returns null state when not running
      const overviewTab = TABS.find((t) => t.key === 'overview')!;

      const deps: AdminDeps = {
        channelManager: { listAll: vi.fn(() => []) } as any,
        topicManager: { listWithCounts: vi.fn(() => []) } as any,
        pollRunManager: {
          progress: vi.fn(() => ({
            runId: 1,
            state: { status: 'idle' as const },
          })),
        } as any,
        db: {
          prepare: vi.fn(() => ({
            all: vi.fn(() => []),
            get: vi.fn(() => ({ summarized: 0, pending: 0 })),
          })),
        } as any,
      };

      const data = overviewTab.dataFn(deps);
      expect(data.currentRunState).toBeNull();
    });
  });
});