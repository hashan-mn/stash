/* One history entry.
 *
 * Layout mirrors the design: [type mark] [preview + meta] [rail].
 * The rail shows the Ctrl-N shortcut normally, and swaps to the four action
 * icons while the row is hovered or selected.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {createIcon} from '../icons.js';
import * as Util from '../util.js';

/* Measured: the 172px column fits ~22 characters per line at 13px, and the
 * design clamps the preview to two lines. previewText() adds the ellipsis. */
const PREVIEW_BUDGET = 44;

const MARK_LABELS = {
    link: 'URL',
    code: 'CMD',
    text: 'TXT',
};

export const HistoryRow = GObject.registerClass({
    Signals: {
        'activated': {},
        'pin-toggled': {},
        'copy-requested': {},
        'remove-requested': {},
        'expand-toggled': {},
        'context-menu': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        'hover-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class HistoryRow extends St.BoxLayout {
    _init(item, index, thumbPath) {
        super._init({
            vertical: true,
            style_class: 'ch-row',
            reactive: true,
            track_hover: true,
            can_focus: false,
            x_expand: true,
        });

        this.item = item;
        this._index = index;
        this._expanded = false;
        this._selected = false;

        const body = new St.BoxLayout({style_class: 'ch-row-body', x_expand: true});
        this.add_child(body);

        body.add_child(this._buildMark(item, thumbPath));
        body.add_child(this._buildText(item));
        body.add_child(this._buildRail(item, index));

        this._detail = null;

        this.connect('notify::hover', () => {
            this._updateRail();
            this.emit('hover-changed', this.hover);
        });

        this.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                this.emit('activated');
                return Clutter.EVENT_STOP;
            }
            if (button === Clutter.BUTTON_SECONDARY) {
                const [x, y] = event.get_coords();
                this.emit('context-menu', x, y);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /* ------------------------------------------------------------ parts --- */

    _buildMark(item, thumbPath) {
        if (item.kind === 'image') {
            const thumb = new St.Bin({style_class: 'ch-thumb'});
            if (thumbPath) {
                thumb.set_style(
                    `background-image: url("${thumbPath}"); ` +
                    'background-size: cover;');
            } else {
                thumb.set_child(new St.Label({
                    text: 'IMG',
                    style_class: 'ch-thumb-label',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            return thumb;
        }

        return new St.Label({
            text: MARK_LABELS[item.type] ?? 'TXT',
            style_class: 'ch-mark',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _buildText(item) {
        /* Fixed width, not x_expand: a long preview's natural width would
         * otherwise squeeze the rail and truncate the "CTRL n" hint. */
        const column = new St.BoxLayout({
            vertical: true,
            style_class: 'ch-row-text',
            x_expand: true,
        });
        column.set_x_expand(true);

        const isMono = item.type === 'code' || item.type === 'link';
        const previewSource = item.kind === 'image' ? item.label : item.full;

        this._preview = new St.Label({
            text: Util.previewText(previewSource, PREVIEW_BUDGET),
            style_class: isMono ? 'ch-preview ch-preview-mono' : 'ch-preview',
            x_expand: true,
        });
        /* St has no line-clamp. ClutterText forces a single line whenever
         * ellipsize is set, so wrapping and ellipsizing are mutually
         * exclusive here: wrap instead, clamp the height to two lines in CSS,
         * and let previewText() supply the trailing ellipsis. */
        this._preview.clutter_text.line_wrap = true;
        this._preview.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._preview.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        column.add_child(this._preview);

        const meta = new St.BoxLayout({style_class: 'ch-meta'});
        this._time = new St.Label({text: Util.relativeTime(item.timestamp).toUpperCase()});
        meta.add_child(this._time);
        meta.add_child(new St.Label({text: '/', style: 'opacity: 0.45;'}));
        meta.add_child(new St.Label({text: (item.source ?? 'Unknown').toUpperCase()}));

        this._pinDot = new St.Bin({style_class: 'ch-pin-dot', y_align: Clutter.ActorAlign.CENTER});
        this._pinDot.visible = !!item.pinned;
        meta.add_child(this._pinDot);

        column.add_child(meta);
        return column;
    }

    _buildRail(item, index) {
        const rail = new St.BoxLayout({
            style_class: 'ch-rail',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._keyHint = new St.Label({
            text: `CTRL ${index + 1}`,
            style_class: 'ch-key-hint',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._keyHint.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._keyHint.visible = index < 9;
        rail.add_child(this._keyHint);

        this._actions = new St.BoxLayout({
            style_class: 'ch-row-actions',
            visible: false,
        });
        this._actions.add_child(this._actionButton('chevron', 'expand-toggled'));
        this._pinButton = this._actionButton('pin', 'pin-toggled');
        this._updatePinButtonStyle();
        this._actions.add_child(this._pinButton);
        this._actions.add_child(this._actionButton('copy', 'copy-requested'));
        this._actions.add_child(this._actionButton('close', 'remove-requested'));
        rail.add_child(this._actions);

        return rail;
    }

    _actionButton(iconName, signal) {
        const button = new St.Button({style_class: 'ch-icon-button'});
        button.set_child(createIcon(iconName, 14));
        button.connect('clicked', () => {
            this.emit(signal);
            /* Stop the click from also activating the row. */
            return Clutter.EVENT_STOP;
        });
        return button;
    }

    /* ----------------------------------------------------------- update --- */

    _updateRail() {
        const showActions = this.hover || this._selected;
        this._actions.visible = showActions;
        this._keyHint.visible = !showActions && this._index < 9;
    }

    _updatePinButtonStyle() {
        if (!this._pinButton)
            return;
        if (this.item.pinned)
            this._pinButton.add_style_class_name('ch-pinned');
        else
            this._pinButton.remove_style_class_name('ch-pinned');
    }

    setSelected(selected) {
        if (this._selected === selected)
            return;
        this._selected = selected;
        if (selected)
            this.add_style_class_name('ch-row-selected');
        else
            this.remove_style_class_name('ch-row-selected');
        this._updateRail();
    }

    get selected() {
        return this._selected;
    }

    setIndex(index) {
        this._index = index;
        this._keyHint.text = `CTRL ${index + 1}`;
        this._updateRail();
    }

    refreshPinned() {
        this._pinDot.visible = !!this.item.pinned;
        this._updatePinButtonStyle();
    }

    refreshTime() {
        this._time.text = Util.relativeTime(this.item.timestamp).toUpperCase();
    }

    get expanded() {
        return this._expanded;
    }

    toggleExpanded() {
        this._expanded = !this._expanded;

        if (!this._expanded) {
            if (this._detail) {
                this._detail.destroy();
                this._detail = null;
            }
            return;
        }

        const text = this.item.kind === 'image'
            ? `${this.item.mime} · ${this.item.width}x${this.item.height} · ` +
              `${Math.round(this.item.byteSize / 1024)} KB`
            : this.item.full;

        this._detail = new St.Label({text, style_class: 'ch-detail', x_expand: true});
        this._detail.clutter_text.line_wrap = true;
        this._detail.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.add_child(this._detail);
    }
});
