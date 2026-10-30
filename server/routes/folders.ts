import type { FolderDTO } from '@timba/shared';
import { EV, MAX_FOLDERS, folderOrderSchema, folderSchema } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { db, now } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { toUser } from '../realtime.js';
import { txt } from '../strings.js';
import { intParam, parse } from '../util.js';

interface FolderRow {
  id: number;
  user_id: number;
  title: string;
  position: number;
  filters: string;
  include_ids: string;
  exclude_ids: string;
}

const DEFAULT_FILTERS = {
  private: false,
  groups: false,
  channels: false,
  excludeMuted: false,
  excludeRead: false,
  excludeArchived: true,
};

function folderDTO(r: FolderRow): FolderDTO {
  return {
    id: r.id,
    title: r.title,
    filters: { ...DEFAULT_FILTERS, ...JSON.parse(r.filters) },
    includeIds: JSON.parse(r.include_ids),
    excludeIds: JSON.parse(r.exclude_ids),
  };
}

export function listFolders(userId: number): FolderDTO[] {
  const rows = db.prepare('SELECT * FROM chat_folders WHERE user_id = ? ORDER BY position, id').all(userId) as FolderRow[];
  return rows.map(folderDTO);
}

/** Every tab of the user gets the new list. */
function changed(userId: number) {
  const list = listFolders(userId);
  toUser(userId, EV.foldersUpdate, list);
  return list;
}

export default async function folderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/folders', async (req) => listFolders(req.auth.user.id));

  app.post('/api/folders', async (req) => {
    const uid = req.auth.user.id;
    const body = parse(folderSchema, req.body);
    const count = (db.prepare('SELECT COUNT(*) c FROM chat_folders WHERE user_id = ?').get(uid) as { c: number }).c;
    if (count >= MAX_FOLDERS) throw badRequest(txt.errors.tooManyFolders(MAX_FOLDERS));
    db.prepare(
      `INSERT INTO chat_folders (user_id, title, position, filters, include_ids, exclude_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(uid, body.title, count, JSON.stringify(body.filters), JSON.stringify(body.includeIds), JSON.stringify(body.excludeIds), now());
    return changed(uid);
  });

  app.put<{ Params: { id: string } }>('/api/folders/:id', async (req) => {
    const uid = req.auth.user.id;
    const body = parse(folderSchema, req.body);
    const r = db
      .prepare('UPDATE chat_folders SET title = ?, filters = ?, include_ids = ?, exclude_ids = ? WHERE id = ? AND user_id = ?')
      .run(body.title, JSON.stringify(body.filters), JSON.stringify(body.includeIds), JSON.stringify(body.excludeIds), intParam(req.params.id), uid);
    if (!r.changes) throw notFound(txt.errors.folderNotFound);
    return changed(uid);
  });

  app.delete<{ Params: { id: string } }>('/api/folders/:id', async (req) => {
    const uid = req.auth.user.id;
    const r = db.prepare('DELETE FROM chat_folders WHERE id = ? AND user_id = ?').run(intParam(req.params.id), uid);
    if (!r.changes) throw notFound(txt.errors.folderNotFound);
    return changed(uid);
  });

  app.put('/api/folders/order', async (req) => {
    const uid = req.auth.user.id;
    const { ids } = parse(folderOrderSchema, req.body);
    const upd = db.prepare('UPDATE chat_folders SET position = ? WHERE id = ? AND user_id = ?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id, uid)))();
    return changed(uid);
  });
}
