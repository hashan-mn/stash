/* Icons drawn with Cairo.
 *
 * The design's icons are stroke-based 24x24 SVGs. St can only recolour
 * *fill*-based symbolic SVGs, so stroked artwork loaded as a file icon would
 * come out the wrong colour. Drawing them here keeps the exact geometry from
 * the design and picks the colour up from the CSS `color` property, so both
 * themes work with no extra assets.
 *
 * Every path below is transcribed verbatim from the design's SVG data.
 */

import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const VIEWBOX = 24;

const DRAWERS = {
    /* <circle cx=11 cy=11 r=7/><path d="M20 20l-3.6-3.6"/> */
    search(cr) {
        cr.arc(11, 11, 7, 0, 2 * Math.PI);
        cr.stroke();
        cr.moveTo(20, 20);
        cr.lineTo(16.4, 16.4);
        cr.stroke();
    },

    /* <path d="M6 6l12 12M18 6L6 18"/> */
    close(cr) {
        cr.moveTo(6, 6);
        cr.lineTo(18, 18);
        cr.moveTo(18, 6);
        cr.lineTo(6, 18);
        cr.stroke();
    },

    /* <path d="M6 10l6 6 6-6"/> */
    chevron(cr) {
        cr.moveTo(6, 10);
        cr.lineTo(12, 16);
        cr.lineTo(18, 10);
        cr.stroke();
    },

    /* <path d="M12 15.5V21"/><path d="M8.5 3.5h7l-1 7.5 3 3.5H6.5l3-3.5-1-7.5z"/> */
    pin(cr) {
        cr.moveTo(12, 15.5);
        cr.lineTo(12, 21);
        cr.stroke();

        cr.moveTo(8.5, 3.5);
        cr.lineTo(15.5, 3.5);
        cr.lineTo(14.5, 11);
        cr.lineTo(17.5, 14.5);
        cr.lineTo(6.5, 14.5);
        cr.lineTo(9.5, 11);
        cr.closePath();
        cr.stroke();
    },

    /* <rect x=9 y=9 width=11 height=11/>
     * <path d="M15 5.5A2.5 2.5 0 0012.5 3H4a1 1 0 00-1 1v8.5A2.5 2.5 0 005.5 15"/>
     * The SVG arcs all have sweep-flag 0, i.e. counter-clockwise. */
    copy(cr) {
        cr.rectangle(9, 9, 11, 11);
        cr.stroke();

        cr.newPath();
        cr.moveTo(15, 5.5);
        cr.arcNegative(12.5, 5.5, 2.5, 0, -Math.PI / 2);       // -> (12.5, 3)
        cr.lineTo(4, 3);                                        // H4
        cr.arcNegative(4, 4, 1, -Math.PI / 2, -Math.PI);        // -> (3, 4)
        cr.lineTo(3, 12.5);                                     // v8.5
        cr.arcNegative(5.5, 12.5, 2.5, Math.PI, Math.PI / 2);   // -> (5.5, 15)
        cr.stroke();
    },
};

/**
 * Read the CSS `color` of an actor as a normalized [r, g, b, a] in 0..1.
 * Clutter.Color exposes 0..255 ints; Cogl.Color (shell 47+) uses 0..1 floats,
 * so normalize defensively rather than assuming either.
 */
function themeColor(actor) {
    try {
        const color = actor.get_theme_node().get_foreground_color();
        const scale = v => (v > 1 ? v / 255 : v);
        return [
            scale(color.red),
            scale(color.green),
            scale(color.blue),
            color.alpha > 1 ? color.alpha / 255 : color.alpha,
        ];
    } catch {
        return [1, 1, 1, 1];
    }
}

/**
 * @param {string} name key in DRAWERS
 * @param {number} size pixel size of the square icon
 * @param {string} styleClass CSS class that supplies the colour
 * @returns {St.DrawingArea}
 */
export function createIcon(name, size = 14, styleClass = '') {
    const drawer = DRAWERS[name];
    if (!drawer)
        throw new Error(`unknown icon: ${name}`);

    const area = new St.DrawingArea({
        width: size,
        height: size,
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
    });

    area.connect('repaint', () => {
        const cr = area.get_context();
        try {
            const scale = size / VIEWBOX;
            cr.scale(scale, scale);
            /* Keep the stroke visually 2px at the design's scale. */
            cr.setLineWidth(2);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setSourceRGBA(...themeColor(area));
            drawer(cr);
        } finally {
            cr.$dispose();
        }
    });

    /* Restyling (theme flip, hover) must repaint with the new colour. */
    area.connect('style-changed', () => area.queue_repaint());

    return area;
}
