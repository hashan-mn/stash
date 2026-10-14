/* Disk persistence.
 *
 * Layout, all under $XDG_DATA_HOME/stash/:
 *   history.json      the entry list (no image payloads)
 *   images/<id>.png   full image payload
 *   thumbs/<id>.png   pre-scaled thumbnail for the row
 *
 * Writes are debounced and atomic (temp file + rename) so a crash mid-write
 * cannot leave a truncated history.json behind.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import * as Util from './util.js';

const SCHEMA_VERSION = 1;
const WRITE_DEBOUNCE_MS = 800;

/* 2x the 52x40 CSS slot, for HiDPI. */
const THUMB_WIDTH = 104;
const THUMB_HEIGHT = 80;

export class Persistence {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'stash']);
        this._imagesDir = GLib.build_filenamev([this._dir, 'images']);
        this._thumbsDir = GLib.build_filenamev([this._dir, 'thumbs']);
        this._historyFile = GLib.build_filenamev([this._dir, 'history.json']);

        this._writeTimeoutId = 0;
        this._pendingItems = null;
    }

    get imagesDir() {
        return this._imagesDir;
    }

    ensureDirs() {
        for (const dir of [this._dir, this._imagesDir, this._thumbsDir]) {
            try {
                Gio.File.new_for_path(dir).make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
        }
    }

    imagePath(id) {
        return GLib.build_filenamev([this._imagesDir, `${id}.png`]);
    }

    thumbPath(id) {
        return GLib.build_filenamev([this._thumbsDir, `${id}.png`]);
    }

    /* ------------------------------------------------------------- load --- */

    /**
     * Read history.json. Returns [] on any problem — a corrupt history is
     * never worth breaking the extension over.
     */
    load() {
        return Util.guard('load history', () => {
            const file = Gio.File.new_for_path(this._historyFile);
            if (!file.query_exists(null))
                return [];

            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return [];

            const text = new TextDecoder().decode(contents);
            const data = JSON.parse(text);

            if (!data || data.version !== SCHEMA_VERSION || !Array.isArray(data.items)) {
                Util.warn('history.json has an unexpected shape, starting empty');
                return [];
            }

            const items = data.items.filter(item => this._isValidItem(item));
            Util.debug(`loaded ${items.length} items`);
            return items;
        }) ?? [];
    }

    _isValidItem(item) {
        if (!item || typeof item !== 'object')
            return false;
        if (typeof item.id !== 'string' || typeof item.hash !== 'string')
            return false;

        if (item.kind === 'image') {
            /* Drop entries whose payload vanished. */
            if (!GLib.file_test(this.imagePath(item.id), GLib.FileTest.EXISTS)) {
                Util.debug(`dropping image entry with no payload: ${item.id}`);
                return false;
            }
            return true;
        }

        return typeof item.full === 'string' && item.full.length > 0;
    }

    /* ------------------------------------------------------------ write --- */

    /** Queue a debounced write of the whole list. */
    schedule(items) {
        this._pendingItems = items;

        if (this._writeTimeoutId)
            return;

        this._writeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE, WRITE_DEBOUNCE_MS, () => {
                this._writeTimeoutId = 0;
                const pending = this._pendingItems;
                this._pendingItems = null;
                if (pending)
                    this._write(pending);
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Write immediately, e.g. on disable(). */
    flush(items) {
        if (this._writeTimeoutId) {
            GLib.source_remove(this._writeTimeoutId);
            this._writeTimeoutId = 0;
        }
        this._pendingItems = null;
        this._write(items);
    }

    _write(items) {
        Util.guard('write history', () => {
            this.ensureDirs();

            const payload = JSON.stringify({
                version: SCHEMA_VERSION,
                items: items.map(item => this._serialize(item)),
            });

            const bytes = new GLib.Bytes(new TextEncoder().encode(payload));

            /* Atomic: write a temp file next to the target, then rename over it. */
            const tmpPath = `${this._historyFile}.tmp`;
            const tmp = Gio.File.new_for_path(tmpPath);
            tmp.replace_contents(
                bytes.get_data(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            tmp.move(
                Gio.File.new_for_path(this._historyFile),
                Gio.FileCopyFlags.OVERWRITE, null, null);

            Util.debug(`wrote ${items.length} items`);
        });
    }

    _serialize(item) {
        const base = {
            id: item.id,
            kind: item.kind,
            type: item.type,
            hash: item.hash,
            source: item.source,
            wmClass: item.wmClass ?? null,
            timestamp: item.timestamp,
            pinned: !!item.pinned,
        };

        if (item.kind === 'image') {
            return Object.assign(base, {
                width: item.width,
                height: item.height,
                byteSize: item.byteSize,
                mime: item.mime,
                label: item.label,
            });
        }

        return Object.assign(base, {full: item.full});
    }

    /* ------------------------------------------------------------ image --- */

    /**
     * Write an image payload plus its thumbnail.
     * Returns {width, height} of the stored image, or null on failure.
     */
    saveImage(id, bytes) {
        return Util.guard('save image', () => {
            this.ensureDirs();

            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
            stream.close(null);

            /* Always normalize to PNG so the loader path is uniform. */
            pixbuf.savev(this.imagePath(id), 'png', [], []);

            const scale = Math.min(
                THUMB_WIDTH / pixbuf.get_width(),
                THUMB_HEIGHT / pixbuf.get_height(),
                1);
            const thumb = pixbuf.scale_simple(
                Math.max(1, Math.round(pixbuf.get_width() * scale)),
                Math.max(1, Math.round(pixbuf.get_height() * scale)),
                GdkPixbuf.InterpType.BILINEAR);
            thumb.savev(this.thumbPath(id), 'png', [], []);

            return {width: pixbuf.get_width(), height: pixbuf.get_height()};
        });
    }

    deleteImage(id) {
        for (const path of [this.imagePath(id), this.thumbPath(id)]) {
            Util.guard('delete image', () => {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null))
                    file.delete(null);
            });
        }
    }

    /** Remove image/thumb files not referenced by any surviving entry. */
    collectGarbage(items) {
        Util.guard('gc images', () => {
            const live = new Set(items.filter(i => i.kind === 'image').map(i => i.id));

            for (const dir of [this._imagesDir, this._thumbsDir]) {
                const dirFile = Gio.File.new_for_path(dir);
                if (!dirFile.query_exists(null))
                    continue;

                const enumerator = dirFile.enumerate_children(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, null);

                let info;
                let removed = 0;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (!name.endsWith('.png'))
                        continue;
                    const id = name.slice(0, -4);
                    if (!live.has(id)) {
                        Util.guard('gc unlink', () =>
                            dirFile.get_child(name).delete(null));
                        removed++;
                    }
                }
                enumerator.close(null);

                if (removed)
                    Util.debug(`gc: removed ${removed} orphan files from ${dir}`);
            }
        });
    }

    /** Delete everything on disk. Used by "Clear all". */
    wipe() {
        Util.guard('wipe', () => {
            const historyFile = Gio.File.new_for_path(this._historyFile);
            if (historyFile.query_exists(null))
                historyFile.delete(null);
            this.collectGarbage([]);
        });
    }

    destroy() {
        if (this._writeTimeoutId) {
            GLib.source_remove(this._writeTimeoutId);
            this._writeTimeoutId = 0;
        }
        this._pendingItems = null;
    }
}
