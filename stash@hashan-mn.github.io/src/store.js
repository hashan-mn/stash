/* History store: the list, dedupe, eviction, filtering.
 *
 * Emits 'changed' whenever the visible list could differ, so the panel can
 * re-render without polling.
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Util from './util.js';

export const Tab = {
    ALL: 'all',
    PINNED: 'pinned',
    IMAGES: 'images',
    LINKS: 'links',
};

export const HistoryStore = GObject.registerClass({
    Signals: {'changed': {}},
}, class HistoryStore extends GObject.Object {
    _init(settings, persistence) {
        super._init();
        this._settings = settings;
        this._persist = persistence;
        this._items = [];
    }

    /* ------------------------------------------------------------- load --- */

    load() {
        const keep = this._settings.get_boolean('keep-after-reboot');
        const loaded = this._persist.load();

        /* Pinned entries survive even when persistence is off; the design
         * promises "pinned ones stay forever". */
        this._items = keep ? loaded : loaded.filter(i => i.pinned);

        if (!keep && loaded.length !== this._items.length)
            this._persist.collectGarbage(this._items);

        this.emit('changed');
    }

    /* -------------------------------------------------------------- add --- */

    /**
     * Record a clip from the monitor. Re-copying something that is already in
     * the history moves it to the top instead of duplicating it.
     */
    add(clip) {
        const existing = this._items.find(i => i.hash === clip.hash);
        if (existing) {
            existing.timestamp = clip.timestamp;
            existing.source = clip.source;
            existing.wmClass = clip.wmClass ?? existing.wmClass;
            this._moveToTop(existing);
            this._save();
            this.emit('changed');
            return existing;
        }

        const id = GLib.uuid_string_random();
        let item;

        if (clip.kind === 'image') {
            const stored = this._persist.saveImage(id, clip.bytes);
            if (!stored) {
                Util.warn('could not store image clip, dropping it');
                return null;
            }
            item = {
                id,
                kind: 'image',
                type: 'image',
                hash: clip.hash,
                width: stored.width,
                height: stored.height,
                byteSize: clip.byteSize,
                mime: clip.mime,
                label: `${stored.width}x${stored.height} image`,
                source: clip.source,
                wmClass: clip.wmClass ?? null,
                timestamp: clip.timestamp,
                pinned: false,
            };
        } else {
            item = {
                id,
                kind: 'text',
                type: clip.type,
                hash: clip.hash,
                full: clip.text,
                source: clip.source,
                wmClass: clip.wmClass ?? null,
                timestamp: clip.timestamp,
                pinned: false,
            };
        }

        this._items.unshift(item);
        this._evict();
        this._save();
        this.emit('changed');
        return item;
    }

    _moveToTop(item) {
        const index = this._items.indexOf(item);
        if (index > 0) {
            this._items.splice(index, 1);
            this._items.unshift(item);
        }
    }

    /** Trim unpinned entries past the limit. Pinned entries never count. */
    _evict() {
        const limit = this._settings.get_int('history-size');
        let unpinnedSeen = 0;
        const survivors = [];
        const evicted = [];

        for (const item of this._items) {
            if (item.pinned) {
                survivors.push(item);
                continue;
            }
            unpinnedSeen++;
            if (unpinnedSeen <= limit)
                survivors.push(item);
            else
                evicted.push(item);
        }

        if (evicted.length === 0)
            return;

        this._items = survivors;
        for (const item of evicted) {
            if (item.kind === 'image')
                this._persist.deleteImage(item.id);
        }
        Util.debug(`evicted ${evicted.length} entries over the ${limit} limit`);
    }

    /* ----------------------------------------------------------- mutate --- */

    togglePin(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.pinned = !item.pinned;
        /* Unpinning can push the list back over the limit. */
        if (!item.pinned)
            this._evict();
        this._save();
        this.emit('changed');
    }

    remove(id) {
        const index = this._items.findIndex(i => i.id === id);
        if (index === -1)
            return;
        const [item] = this._items.splice(index, 1);
        if (item.kind === 'image')
            this._persist.deleteImage(item.id);
        this._save();
        this.emit('changed');
    }

    clear() {
        this._items = [];
        this._persist.wipe();
        this.emit('changed');
    }

    /* ------------------------------------------------------------ query --- */

    get all() {
        return this._items;
    }

    get counts() {
        return {
            [Tab.ALL]: this._items.length,
            [Tab.PINNED]: this._items.filter(i => i.pinned).length,
            [Tab.IMAGES]: this._items.filter(i => i.type === 'image').length,
            [Tab.LINKS]: this._items.filter(i => i.type === 'link').length,
        };
    }

    /**
     * The list the panel renders: tab filter, then search, then pinned-first.
     * The underlying array is already newest-first, and sort() is stable, so
     * pinned entries keep their relative recency order.
     */
    visible(tab = Tab.ALL, query = '') {
        const q = query.trim().toLowerCase();

        const filtered = this._items.filter(item => {
            if (tab === Tab.PINNED && !item.pinned)
                return false;
            if (tab === Tab.IMAGES && item.type !== 'image')
                return false;
            if (tab === Tab.LINKS && item.type !== 'link')
                return false;

            if (q) {
                const haystack = `${this.searchText(item)} ${item.source}`.toLowerCase();
                if (!haystack.includes(q))
                    return false;
            }
            return true;
        });

        return filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    }

    /** Text used for searching and for the row preview. */
    searchText(item) {
        return item.kind === 'image' ? item.label : item.full;
    }

    /* ------------------------------------------------------------- save --- */

    _save() {
        if (this._settings.get_boolean('keep-after-reboot'))
            this._persist.schedule(this._items);
        else
            this._persist.schedule(this._items.filter(i => i.pinned));
    }

    flush() {
        if (this._settings.get_boolean('keep-after-reboot'))
            this._persist.flush(this._items);
        else
            this._persist.flush(this._items.filter(i => i.pinned));
    }
});
