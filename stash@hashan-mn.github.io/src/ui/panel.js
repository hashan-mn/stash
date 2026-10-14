/* The Super+V panel: 360x520, anchored bottom-right, dark by default.
 *
 * Built from St.BoxLayout rather than CSS flexbox, which St does not support.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ContextMenu, SettingsPopover} from './menu.js';
import {HistoryRow} from './row.js';
import {Tab} from '../store.js';
import {createIcon} from '../icons.js';
import * as Util from '../util.js';

const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 520;
const EDGE_MARGIN = 56;

const OPEN_DURATION = 260;
const CLOSE_DURATION = 200;
const RISE = 24;

const TOAST_DURATION = 1400;

const TABS = [
    {key: Tab.ALL, label: 'All'},
    {key: Tab.PINNED, label: 'Pinned'},
    {key: Tab.IMAGES, label: 'Images'},
    {key: Tab.LINKS, label: 'Links'},
];

/**
 * A St.Button's built-in `label` property ellipsizes as soon as the parent
 * box is tight, regardless of min-width. Supplying the label actor directly
 * and disabling ellipsize is the only way to keep short button text intact.
 */
function textButton(text, styleClass, extraProps = {}) {
    const button = new St.Button({
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        ...extraProps,
    });
    const label = new St.Label({
        text,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    button.set_child(label);
    return button;
}

const EMPTY_COPY = {
    [Tab.ALL]: [
        'Nothing copied yet',
        'Everything you copy lands here. The last {n} items are kept, pinned ones stay forever.',
    ],
    [Tab.PINNED]: [
        'No pinned items',
        'Pin an entry with P or the pin icon to keep it at the top of the list.',
    ],
    [Tab.IMAGES]: [
        'No images copied',
        'Screenshots and copied images appear here with a thumbnail preview.',
    ],
    [Tab.LINKS]: [
        'No links copied',
        'Copied URLs are detected automatically and grouped here.',
    ],
};

export const ClipboardPanel = GObject.registerClass({
    Signals: {
        /* id, pasteAsPlainText */
        'item-activated': {param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN]},
        'item-copied': {param_types: [GObject.TYPE_STRING]},
        'open-preferences': {},
        'closed': {},
    },
}, class ClipboardPanel extends St.Widget {
    _init(store, settings, persistence) {
        /* A BinLayout stacks the content column and a fixed-position overlay.
         * Popups and the toast must be free to sit anywhere inside the panel;
         * a BoxLayout would lay them out in sequence and ignore set_position. */
        super._init({
            style_class: 'ch-panel',
            reactive: true,
            visible: false,
            layout_manager: new Clutter.BinLayout(),
        });

        this._store = store;
        this._settings = settings;
        this._persist = persistence;

        this._tab = Tab.ALL;
        this._query = '';
        this._selectedIndex = 0;
        this._rows = [];
        this._isOpen = false;
        this._searchFocused = false;
        this._grab = null;
        this._menu = null;
        this._settingsPopover = null;
        this._toast = null;
        this._toastTimeoutId = 0;
        this._stagePressId = 0;

        this._applyTheme();

        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._content.add_child(this._buildHeader());
        this._content.add_child(this._buildList());
        this._content.add_child(this._buildFooter());
        this.add_child(this._content);

        /* Popups and the toast live here, positioned absolutely. Not reactive
         * itself, so clicks fall through to the content underneath. */
        this._overlay = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._overlay);

        this._storeChangedId = this._store.connect('changed', () => {
            if (this._isOpen)
                this._rebuild();
        });

        this._themeChangedId = this._settings.connect('changed::theme', () => this._applyTheme());

        this.connect('key-press-event', (_a, event) => this._onKeyPress(event));
        this._entry.clutter_text.connect('key-press-event', (_a, event) => this._onKeyPress(event));
        this._entry.clutter_text.connect('key-focus-in', () => {
            this._searchFocused = true;
        });
        this._entry.clutter_text.connect('key-focus-out', () => {
            this._searchFocused = false;
        });

        this._settingsButton.connect('clicked', () => this._toggleSettingsPopover());

        Main.layoutManager.addTopChrome(this);
    }

    /* ------------------------------------------------------------ theme --- */

    _applyTheme() {
        const theme = this._settings.get_string('theme');
        const dark = theme !== 'light';
        this.remove_style_class_name(dark ? 'ch-light' : 'ch-dark');
        this.add_style_class_name(dark ? 'ch-dark' : 'ch-light');
    }

    /* ----------------------------------------------------------- header --- */

    _buildHeader() {
        const header = new St.BoxLayout({
            vertical: true,
            style_class: 'ch-header',
            x_expand: true,
        });

        const titleRow = new St.BoxLayout({x_expand: true});

        /* The title must never shrink; the count yields space instead. */
        const title = new St.Label({
            text: 'CLIPBOARD',
            style_class: 'ch-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        titleRow.add_child(title);

        this._countLabel = new St.Label({
            text: '',
            style_class: 'ch-count',
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            style: 'padding-left: 9px;',
        });
        this._countLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleRow.add_child(this._countLabel);

        this._settingsButton = new St.Button({
            label: '⋯',
            style_class: 'ch-chrome-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(this._settingsButton);

        header.add_child(titleRow);
        header.add_child(this._buildSearch());
        header.add_child(this._buildTabs());

        return header;
    }

    _buildSearch() {
        const box = new St.BoxLayout({style_class: 'ch-search', x_expand: true});

        box.add_child(createIcon('search', 15));

        this._entry = new St.Entry({
            style_class: 'ch-search-entry',
            hint_text: 'Search clipboard',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._query = this._entry.get_text();
            this._selectedIndex = 0;
            this._rebuild();
        });
        box.add_child(this._entry);

        this._clearButton = new St.Button({
            style_class: 'ch-icon-button',
            visible: false,
        });
        this._clearButton.set_child(createIcon('close', 14));
        this._clearButton.connect('clicked', () => this.clearQuery());
        box.add_child(this._clearButton);

        return box;
    }

    _buildTabs() {
        const box = new St.BoxLayout({style_class: 'ch-tabs', x_expand: true});
        this._tabButtons = new Map();

        TABS.forEach((tab, index) => {
            const button = new St.Button({
                style_class: 'ch-tab',
                x_expand: true,
                can_focus: false,
            });

            /* St has no :first-child border trick, so divider classes are
             * applied per-button instead. */
            if (index > 0)
                button.add_style_class_name('ch-tab-divider');

            const content = new St.BoxLayout({style: 'spacing: 6px;'});
            const label = new St.Label({
                text: tab.label.toUpperCase(),
                y_align: Clutter.ActorAlign.CENTER,
            });
            const count = new St.Label({
                text: '0',
                style_class: 'ch-tab-count',
                y_align: Clutter.ActorAlign.CENTER,
            });
            content.add_child(label);
            content.add_child(count);
            button.set_child(content);

            button.connect('clicked', () => this.setTab(tab.key));

            this._tabButtons.set(tab.key, {button, count});
            box.add_child(button);
        });

        return box;
    }

    /* ------------------------------------------------------------- list --- */

    _buildList() {
        this._scroll = new St.ScrollView({
            style_class: 'ch-list',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });

        this._listBox = new St.BoxLayout({vertical: true, x_expand: true});
        this._scroll.set_child(this._listBox);

        return this._scroll;
    }

    /* ----------------------------------------------------------- footer --- */

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'ch-footer', x_expand: true});

        /* The hint yields space to the button rather than the other way
         * round, so "CLEAR ALL" is never truncated. */
        const hint = new St.Label({
            text: '↑↓ SELECT   ENTER PASTE   ESC CLOSE',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        hint.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        footer.add_child(hint);

        this._clearAllButton = textButton('CLEAR ALL', 'ch-footer-button');
        this._clearAllButton.connect('clicked', () => {
            this._store.clear();
            this._rebuild();
        });
        footer.add_child(this._clearAllButton);

        return footer;
    }

    /* ---------------------------------------------------------- rebuild --- */

    _rebuild() {
        this._listBox.destroy_all_children();
        this._rows = [];

        const items = this._store.visible(this._tab, this._query);
        const counts = this._store.counts;

        for (const [key, {button, count}] of this._tabButtons) {
            count.text = `${counts[key]}`;
            if (key === this._tab)
                button.add_style_class_name('ch-tab-active');
            else
                button.remove_style_class_name('ch-tab-active');
        }

        this._countLabel.text =
            `${counts[Tab.ALL]} items / ${counts[Tab.PINNED]} pinned`;

        this._clearButton.visible = this._query.trim().length > 0;

        if (items.length === 0) {
            this._listBox.add_child(this._buildEmptyState());
            this._selectedIndex = 0;
            return;
        }

        this._selectedIndex = Math.max(0, Math.min(this._selectedIndex, items.length - 1));

        items.forEach((item, index) => {
            const thumbPath = item.kind === 'image'
                ? this._persist.thumbPath(item.id)
                : null;

            const row = new HistoryRow(item, index, thumbPath);
            row.setSelected(index === this._selectedIndex);

            row.connect('activated', () => this._activate(item));
            row.connect('pin-toggled', () => this._store.togglePin(item.id));
            row.connect('remove-requested', () => this._store.remove(item.id));
            row.connect('expand-toggled', () => row.toggleExpanded());
            row.connect('copy-requested', () => this.emit('item-copied', item.id));
            row.connect('context-menu', (_r, x, y) => this._openContextMenu(item, x, y));
            row.connect('hover-changed', (_row, hovered) => {
                if (hovered)
                    this._setSelected(index, false);
            });

            this._rows.push(row);
            this._listBox.add_child(row);
        });
    }

    _buildEmptyState() {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'ch-empty',
            x_expand: true,
        });

        const query = this._query.trim();
        let title, subtitle;

        if (query) {
            title = `No match for "${query}"`;
            subtitle = 'Try a shorter term, or switch to All to search the whole history.';
        } else {
            const copy = EMPTY_COPY[this._tab];
            title = copy[0];
            subtitle = copy[1].replace('{n}', `${this._settings.get_int('history-size')}`);
        }

        /* The design left-aligns the empty state; without an explicit align
         * every child would stretch to the full panel width. */
        const START = Clutter.ActorAlign.START;

        box.add_child(new St.Bin({style_class: 'ch-empty-mark', x_align: START}));

        box.add_child(new St.Label({
            text: title,
            style_class: 'ch-empty-title',
            x_align: START,
        }));

        const sub = new St.Label({
            text: subtitle,
            style_class: 'ch-empty-sub',
            x_align: START,
        });
        sub.clutter_text.line_wrap = true;
        sub.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(sub);

        if (query) {
            const button = textButton('CLEAR SEARCH', 'ch-empty-button', {x_align: START});
            button.connect('clicked', () => this.clearQuery());
            box.add_child(button);
        }

        return box;
    }

    /* --------------------------------------------------------- selection --- */

    _setSelected(index, scroll = true) {
        if (this._rows.length === 0)
            return;

        const clamped = Math.max(0, Math.min(index, this._rows.length - 1));
        this._rows.forEach((row, i) => row.setSelected(i === clamped));
        this._selectedIndex = clamped;

        if (scroll)
            this._scrollTo(this._rows[clamped]);
    }

    _scrollTo(row) {
        const adjustment = this._scroll.get_vadjustment();
        const [, rowY] = row.get_transformed_position();
        const [, listY] = this._listBox.get_transformed_position();
        const top = rowY - listY;
        const bottom = top + row.height;

        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    get selectedItem() {
        const row = this._rows[this._selectedIndex];
        return row ? row.item : null;
    }

    _activate(item, plainText = false) {
        this.emit('item-activated', item.id, plainText);
    }

    /* -------------------------------------------------------- keyboard --- */

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

        /* Any key dismisses an open popup first. */
        if (symbol === Clutter.KEY_Escape && (this._menu || this._settingsPopover)) {
            this._closePopups();
            return Clutter.EVENT_STOP;
        }

        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._setSelected(this._selectedIndex + 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._setSelected(this._selectedIndex - 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter: {
            const item = this.selectedItem;
            if (item)
                this._activate(item);
            return Clutter.EVENT_STOP;
        }

        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            const index = TABS.findIndex(t => t.key === this._tab);
            const next = symbol === Clutter.KEY_Tab
                ? (index + 1) % TABS.length
                : (index - 1 + TABS.length) % TABS.length;
            this.setTab(TABS[next].key);
            return Clutter.EVENT_STOP;
        }

        case Clutter.KEY_slash:
            if (!this._searchFocused) {
                this._entry.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            break;
        }

        /* Ctrl+1..9 pastes by position, matching the CTRL n hints. */
        if (ctrl && symbol >= Clutter.KEY_1 && symbol <= Clutter.KEY_9) {
            const index = symbol - Clutter.KEY_1;
            const row = this._rows[index];
            if (row) {
                this._setSelected(index);
                this._activate(row.item);
            }
            return Clutter.EVENT_STOP;
        }

        /* Single-letter actions would otherwise be typed into the search
         * field, so they only apply when the field does not have focus. */
        if (this._searchFocused)
            return Clutter.EVENT_PROPAGATE;

        switch (symbol) {
        case Clutter.KEY_p:
        case Clutter.KEY_P: {
            const item = this.selectedItem;
            if (item)
                this._store.togglePin(item.id);
            return Clutter.EVENT_STOP;
        }

        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
        case Clutter.KEY_BackSpace: {
            const item = this.selectedItem;
            if (item)
                this._store.remove(item.id);
            return Clutter.EVENT_STOP;
        }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    /* ---------------------------------------------------------- popups --- */

    _closePopups() {
        if (this._menu) {
            this._menu.destroy();
            this._menu = null;
        }
        if (this._settingsPopover) {
            this._settingsPopover.destroy();
            this._settingsPopover = null;
        }
    }

    _openContextMenu(item, stageX, stageY) {
        this._closePopups();

        const [panelX, panelY] = this.get_transformed_position();
        const menu = new ContextMenu(item);
        this._overlay.add_child(menu);
        menu.positionWithin(
            PANEL_WIDTH, PANEL_HEIGHT,
            Math.round(stageX - panelX), Math.round(stageY - panelY));

        menu.connect('action', (_m, action) => {
            this._closePopups();
            switch (action) {
            case 'paste':
                this._activate(item);
                break;
            case 'plain':
                this._activate(item, true);
                break;
            case 'copy':
                this.emit('item-copied', item.id);
                break;
            case 'pin':
                this._store.togglePin(item.id);
                break;
            case 'delete':
                this._store.remove(item.id);
                break;
            }
        });

        this._menu = menu;
    }

    _toggleSettingsPopover() {
        if (this._settingsPopover) {
            this._closePopups();
            return;
        }
        this._closePopups();

        const popover = new SettingsPopover(this._settings);
        this._overlay.add_child(popover);
        popover.set_position(PANEL_WIDTH - 230 - 12, 44);
        popover.connect('open-preferences', () => {
            this._closePopups();
            this.emit('open-preferences');
        });
        this._settingsPopover = popover;
    }

    /* ----------------------------------------------------------- toast --- */

    showToast(message) {
        if (this._toast) {
            this._toast.destroy();
            this._toast = null;
        }
        if (this._toastTimeoutId) {
            GLib.source_remove(this._toastTimeoutId);
            this._toastTimeoutId = 0;
        }

        const toast = new St.Label({
            text: message.toUpperCase(),
            style_class: 'ch-toast',
        });
        toast.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._overlay.add_child(toast);
        toast.set_position(14, PANEL_HEIGHT - 48 - toast.get_preferred_height(PANEL_WIDTH - 28)[1]);
        toast.set_width(PANEL_WIDTH - 28);

        toast.opacity = 0;
        toast.translation_y = 6;
        toast.ease({
            opacity: 255,
            translation_y: 0,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._toast = toast;
        this._toastTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_DURATION, () => {
            this._toastTimeoutId = 0;
            if (this._toast) {
                this._toast.destroy();
                this._toast = null;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ------------------------------------------------------------ state --- */

    setTab(tab) {
        this._tab = tab;
        this._selectedIndex = 0;
        this._rebuild();
    }

    get tab() {
        return this._tab;
    }

    clearQuery() {
        this._entry.set_text('');
        this._query = '';
        this._selectedIndex = 0;
        this._rebuild();
    }

    /* ------------------------------------------------------ open / close --- */

    _position() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        this.set_size(PANEL_WIDTH, PANEL_HEIGHT);
        this.set_position(
            workArea.x + workArea.width - PANEL_WIDTH - EDGE_MARGIN,
            workArea.y + workArea.height - PANEL_HEIGHT - EDGE_MARGIN);
    }

    open() {
        if (this._isOpen)
            return;

        this._isOpen = true;
        this._query = '';
        this._entry.set_text('');
        this._selectedIndex = 0;
        this._rebuild();

        this._position();
        this.show();

        /* A modal grab is what lets a shell actor receive the keyboard at
         * all; without it Super+V would open a panel that ignores every key. */
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.NORMAL});
        if (!this._grab)
            Util.warn('could not take a modal grab; keyboard control unavailable');

        this.grab_key_focus();

        /* Clicking outside the panel dismisses it. */
        this._stagePressId = global.stage.connect('button-press-event', (_a, event) => {
            const [x, y] = event.get_coords();
            const [px, py] = this.get_transformed_position();
            const inside = x >= px && x <= px + PANEL_WIDTH &&
                           y >= py && y <= py + PANEL_HEIGHT;
            if (!inside) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            /* A click anywhere in the panel closes a stray popup. */
            if (this._menu || this._settingsPopover)
                this._closePopups();
            return Clutter.EVENT_PROPAGATE;
        });

        this.remove_all_transitions();
        this.opacity = 0;
        this.translation_y = RISE;
        this.ease({
            opacity: 255,
            translation_y: 0,
            duration: OPEN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        Util.debug('panel opened');
    }

    close() {
        if (!this._isOpen)
            return;

        this._isOpen = false;

        this._closePopups();
        this._releaseGrab();

        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            translation_y: RISE,
            duration: CLOSE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.hide();
                this.emit('closed');
            },
        });

        Util.debug('panel closed');
    }

    _releaseGrab() {
        if (this._stagePressId) {
            global.stage.disconnect(this._stagePressId);
            this._stagePressId = 0;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    get isOpen() {
        return this._isOpen;
    }

    destroy() {
        this._releaseGrab();
        this._closePopups();

        if (this._toastTimeoutId) {
            GLib.source_remove(this._toastTimeoutId);
            this._toastTimeoutId = 0;
        }

        if (this._storeChangedId) {
            this._store.disconnect(this._storeChangedId);
            this._storeChangedId = 0;
        }
        if (this._themeChangedId) {
            this._settings.disconnect(this._themeChangedId);
            this._themeChangedId = 0;
        }
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
