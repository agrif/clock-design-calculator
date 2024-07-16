ko.extenders.numeric = function(target, arg) {
    let start = target();

    let result = ko.pureComputed({
        read: target,
        write: function(value) {
            let current = target();
            let num = isNaN(value) ? start : +value;

            if (num !== current) {
                target(num);
            } if (value !== current) {
                result.notifySubscribers(num);
            }
        },
    }).extend({notify: 'always'});

    result(start);

    return result;
}

let typeset_promise = Promise.resolve();

ko.bindingHandlers.latex = {
    update: function(element, value) {
        ko.bindingHandlers.html.update.apply(this, arguments);

        typeset_promise = typeset_promise.then(function() {
            MathJax.typesetPromise([element]);
        }).catch(function(err) {
            console.log('Typeset failed: ' + err.message);
        });
    },
};

let ParameterGroup = function(name) {
    this.name = name;
    this.parameters = [];

    this.push = function(obj) {
        obj.template = obj.template || 'field-default';
        obj.tooltip = obj.tooltip || false;
        obj.symbol = '$' + obj.symbol + '$';
        this.parameters.push(obj);
        return obj.value;
    };

    this.base_mul = function(obj) {
        obj.template = obj.template || 'field-base-mul';
        obj.value = obj.value || ko.pureComputed(function() {
            return this.base() * this.mul();
        }, obj);
        return this.push(obj);
    };
};

let ResultGroup = function(name) {
    this.name = name;
    this.results = [];

    this.push = function(obj) {
        obj.tooltip = obj.tooltip || false;
        obj.symbol = '$' + obj.symbol + '$';
        obj.equation = '$' + obj.equation + '$';
        obj.relation = obj.relation || '=';
        obj.relation = '$' + obj.relation + '$';
        obj.unit = obj.unit || '';
        obj.sigfigs = obj.sigfigs || 3;
        obj.check = obj.check || false;
        obj.note = obj.note || ko.pureComputed(function() {
            return this.check()[1];
        }, obj);
        obj.valid = obj.valid || ko.pureComputed(function() {
            return this.check()[0];
        }, obj);
        obj.value_pretty = obj.value_pretty || ko.pureComputed(function() {
            return unitify(this.value(), this.unit, this.sigfigs);
        }, obj);
        this.results.push(obj);
        return obj.value;
    };
};

let SI_TABLE = [
    ['p', 1e-12],
    ['n', 1e-9],
    ['μ', 1e-6],
    ['m', 1e-3],
    ['', 1],
    ['k', 1e3],
    ['M', 1e6],
    ['G', 1e9],
    ['T', 1e12],
];

function units(base, min, max) {
    let units = [];
    SI_TABLE.forEach(function(el) {
        if (min <= el[1] && el[1] <= max) {
            units.push({name: el[0] + base, mul: el[1]});
        }
    });
    return units;
}

function sigfig(n, sigfigs) {
    let last_digit = Math.floor(Math.log10(n)) - sigfigs + 1;
    let base = 10.0 ** last_digit;
    let rounded = Math.round(n / base) * base;
    return rounded.toFixed(last_digit > 0 ? 0 : -last_digit);
}

function unitify(n, unit, sigfigs) {
    if (!unit) {
        return sigfig(n, sigfigs);
    }
    
    let prefix = SI_TABLE[0];
    for (let el of SI_TABLE) {
        if (el[1] > n) {
            break;
        }
        prefix = el;
    }

    return sigfig(n / prefix[1], sigfigs) + ' ' + prefix[0] + unit;
}

let Calculator = function() {
    this.crystal = new ParameterGroup("Crystal Specifications");
    this.mcu = new ParameterGroup("MCU Specifications");
    this.pcb = new ParameterGroup("PCB and Layout");

    this.parameter_groups = [this.crystal, this.mcu, this.pcb];

    this.results = new ResultGroup("Results");

    this.result_groups = [this.results];

    this.parameter = function(value) {
        return ko.observable(value).extend({numeric: true});
    };

    this.f = this.crystal.base_mul({
        name: "Frequency",
        symbol: "F",
        base: this.parameter(8),
        mul: this.parameter(1_000_000),
        units: units("Hz", 1, 1e6),
    });

    this.esr = this.crystal.push({
        name: "Equivalent Series Resistance",
        symbol: "ESR",
        tooltip: "If the crystal specifications don't provide $ESR$, you may calculate it from the motional resistance $R_m$, the shunt capacitance $C_0$, and the load capacitance $C_L$: $$ESR = R_m \\times \\left( 1 + \\frac{C_0}{C_L} \\right)^2.$$",
        value: this.parameter(40),
        unit: "Ω",
    });

    this.c_l = this.crystal.base_mul({
        name: "Load Capacitance",
        symbol: "C_L",
        tooltip: "This is the load capacitance required by the crystal to oscillate at its frequency $F$. This capacitance is set by the load capacitors $C_{L1}$ and $C_{L2}$ as well as the stray capacitance $C_{stray}$.",
        base: this.parameter(16),
        mul: this.parameter(1e-12),
        units: units("F", 1e-12, 1e-3),
    });

    this.c_0 = this.crystal.base_mul({
        name: "Shunt Capacitance",
        symbol: "C_0",
        base: this.parameter(7),
        mul: this.parameter(1e-12),
        units: units("F", 1e-12, 1e-3),
    });

    this.dl_max = this.crystal.base_mul({
        name: "Max Drive Level",
        symbol: "DL_{max}",
        tooltip: "Sometimes just called drive level in the spec sheet.",
        base: this.parameter(500),
        mul: this.parameter(1e-6),
        units: units("W", 1e-9, 1e-3),
    });

    this.vcc = this.mcu.push({
        name: "Supply Voltage",
        symbol: "V_{cc}",
        value: this.parameter(3.3),
        unit: "V",
    });

    this.g_m = this.mcu.base_mul({
        name: "Transconductance",
        symbol: "g_m",
        tooltip: "The transconductance of the MCU's oscillator port. Your MCU may give this instead as a maximum critical transconductance, $g_{m\\_crit\\_max}$, in which case you should multiply that value by 5 here.",
        base: this.parameter(10),
        mul: this.parameter(1e-3),
        units: units("A / V", 1e-9, 1),
    });

    this.c_stray = this.pcb.base_mul({
        name: "Stray Capacitance",
        symbol: "C_{stray}",
        tooltip: "The stray capacitance of the PCB and routed traces. This should be measured for important applications, but 5pF is a reasonable estimate.",
        base: this.parameter(5),
        mul: this.parameter(1e-12),
        units: units("F", 1e-12, 1e-3),
    });

    this.r_ext = this.pcb.base_mul({
        name: "External Resistor",
        symbol: "R_{ext}",
        tooltip: "You can modify this value here to adjust the drive level, the amount of power pushed through the crystal. 0 is usually fine.",
        base: this.parameter(0),
        mul: this.parameter(1),
        units: units("Ω", 1, 1e6),
    });

    this.c_l1 = this.results.push({
        name: "External Load Capacitors",
        symbol: "C_{L1} = C_{L2}",
        tooltip: "This is the value for the two external capacitors between the two pins of the crystal and ground.",
        equation: "2 \\times (C_L - C_{stray})",
        value: ko.pureComputed(function() {
            return 2.0 * (this.c_l() - this.c_stray());
        }, this),
        unit: 'F',
    });

    this.g_m_crit = this.results.push({
        name: "Critical Transconductance",
        symbol: "g_{m\\_crit}",
        tooltip: "This is the transconductance needed for this oscillator to start.",
        equation: "4 \\times (ESR + R_{ext}) \\times (2 \\pi F)^2 \\times (C_0 + C_L)^2",
        value: ko.pureComputed(function() {
            return 4.0 * (this.esr() + this.r_ext()) * ((2 * Math.PI * this.f()) ** 2) * ((this.c_0() + this.c_l()) ** 2);
        }, this),
        unit: 'A / V',
    });

    this.gain_margin = this.results.push({
        name: "Gain Margin",
        symbol: "\\text{gain margin}",
        tooltip: "This is the ratio of the MCU's transductance to the critical oscillator tranductance. This should be at least 5 for the oscillator to function reliably.",
        equation: "g_m / g_{m\\_crit}",
        value: ko.pureComputed(function() {
            return this.g_m() / this.g_m_crit();
        }, this),
        check: ko.pureComputed(function() {
            if (this.gain_margin() >= 5) {
                return [true, "This margin is at least 5, indicating $g_m \\gg g_{m\\_crit}$ and stable operation."];
            } else {
                return [false, "This margin is below 5! $g_m$ is not much larger than $g_{m\\_crit} and this oscillator may not be stable."];
            }
        }, this),
    });

    this.dl = this.results.push({
        name: "Drive Level",
        symbol: "DL",
        tooltip: "This is the drive level of the oscillator as used by the MCU. This cannot exceed the max drive level $DL_{max}$. Note that this is an estimate that uses the supply voltage $V_{cc}$ as an upper bound for the peak-to-peak oscillator voltage $\\Delta V$. This estimate also entirely ignores the effect of $R_{ext}$, which is used to limit the drive level.",
        relation: "\\approx",
        equation: "\\frac{1}{2} \\times ESR \\times \\left( \\pi F \\times (C_{L1} + \\frac{1}{2} C_{stray}) \\right)^2 \\times V_{cc}^2",
        value: ko.pureComputed(function() {
            // FIXME this is *not* ESR + R_EXT
            // what is it??
            c_tot = this.c_l1() + 0.5 * this.c_stray();
            return 0.5 * this.esr() * ((Math.PI * this.f() * c_tot) ** 2) * (this.vcc() ** 2);
        }, this),
        unit: 'W',
        check: ko.pureComputed(function() {
            if (this.dl() <= this.dl_max()) {
                return [true, "This drive level is less than $DL_{max}$, and within the crystal's tolerance."];
            } else {
                return [false, "This drive level exceeds $DL_{max}$, the crystal's max drive level! This may damage the crystal or otherwise fail. Consider using an external resistor or a different crystal. AN2867 recommends starting at $$R_{ext} = \\frac{1}{2 \\pi F \\times C_{L2}},$$ which is " + this.r_ext_recommended() + ". Note that this resistor is currently ignored by this calculation!"];
            }
        }, this),

    });

    // this one is special, and only appears inside the note for drive level
    this.r_ext_recommended = ko.pureComputed(function() {
        // "R_{ext}^{\\text{rec}}",
        // "(2 \\pi F \\times C_{L2})^{-1}"
        let r = 1.0 / (2.0 * Math.PI * this.f() * this.c_l1());
        return unitify(r, "Ω", 3);
    }, this);
};
