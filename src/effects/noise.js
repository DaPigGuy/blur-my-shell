import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import * as utils from '../conveniences/utils.js';
const Shell = await utils.import_in_shell_only('gi://Shell');
const SHADER_FILENAME = 'noise.glsl';


export const NoiseEffect = new GObject.registerClass({
    GTypeName: "NoiseEffect",
    Properties: {
        'noise': GObject.ParamSpec.double(
            `noise`,
            `Noise`,
            `Amount of noise integrated with the image`,
            GObject.ParamFlags.READWRITE,
            0.0, 1.0,
            0.4,
        ),
        'lightness': GObject.ParamSpec.double(
            `lightness`,
            `Lightness`,
            `Lightness of the grey used for the noise`,
            GObject.ParamFlags.READWRITE,
            0.0, 2.0,
            0.4,
        ),
    }
}, class NoiseEffect extends Clutter.ShaderEffect {
    constructor(params) {
        super(params);

        this._noise = null;
        this._lightness = null;

        this.noise = 'noise' in params ? params.noise : this.constructor.default_params.noise;
        this.lightness = 'lightness' in params ? params.lightness : this.constructor.default_params.lightness;

        // set shader source
        this._source = utils.get_shader_source(Shell, SHADER_FILENAME, import.meta.url);
        if (this._source)
            this.set_shader_source(this._source);
    }

    static get default_params() {
        return { noise: 0.4, lightness: 0.4 };
    }

    get noise() {
        return this._noise;
    }

    set noise(value) {
        if (this._noise !== value) {
            this._noise = value;

            this.set_uniform_value('noise', parseFloat(this._noise - 1e-6));
            this.set_enabled(this.noise > 0. && this.lightness != 1);
        }
    }

    get lightness() {
        return this._lightness;
    }

    set lightness(value) {
        if (this._lightness !== value) {
            this._lightness = value;

            this.set_uniform_value('lightness', parseFloat(this._lightness - 1e-6));
            this.set_enabled(this.noise > 0. && this.lightness != 1);
        }
    }

    vfunc_paint_target(paint_node = null, paint_context = null) {
        this.set_uniform_value("tex", 0);

        if (paint_node && paint_context)
            super.vfunc_paint_target(paint_node, paint_context);
        else if (paint_node)
            super.vfunc_paint_target(paint_node);
        else
            super.vfunc_paint_target();
    }
});