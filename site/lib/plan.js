// What to actually do about a gap: a step-by-step plan with the tools, the structure to build,
// the models to switch on, the runs or measurements, what to compare against and the expected
// outcome. Built from the field's playbook in config.json, so every gap gets the same depth.

const ROUTES = {
  tcad: "TCAD simulation",
  fab: "Fabrication and measurement",
  circuit: "Compact model and circuit simulation",
  study: "Literature check, then simulation",
};
const SHORT = { tcad: "TCAD plan", fab: "Fabrication plan", circuit: "Circuit plan", study: "Plan" };

// Which route a gap needs. Rule gaps know their type; AI gaps give a stage and words.
export function routeOf(g) {
  const t = g.type;
  if (t === "not_fabricated") return "fab";
  if (t === "missing_feature") return "tcad";
  if (t === "not_in_circuit") return "circuit";
  if (t === "cross_topic" || t === "combination") return "tcad";
  const s = ((g.stage || "") + " " + (g.title || "")).toLowerCase();
  if (/fabricat|measure|silicon|prototype|wafer/.test(s)) return "fab";
  if (/circuit|eda|spice|array|system|compact model|verilog/.test(s)) return "circuit";
  if (/tcad|simulat|model|physics/.test(s)) return "tcad";
  return "study";
}

const lc = (s) => String(s || "").toLowerCase();

function tcadPhases(pb, cat, feat, g) {
  const T = pb.tcad;
  return [
    { title: "Set up the simulation", tools: T.tools, steps: [
      "Build the structure: " + T.structure,
      "Calibrate first. " + T.calibrate,
    ] },
    { title: "Switch on the physics", tools: [], steps: [
      ...T.models,
      ...(feat ? ["For this gap, add " + lc(feat.name) + ": " + feat.tcad] : []),
    ] },
    { title: "Run the simulations", tools: [], steps: T.runs },
    { title: "Compare and report", tools: [], steps: [
      feat ? `Run every case twice, with and without ${lc(feat.name)}, and plot the difference in ${T.figure}.`
        : `Compare against the paper's reported ${T.figure}, then change one design variable at a time.`,
      "Check your baseline against the measured papers listed under \"Based on these papers\".",
      g && g.type === "combination" ? "Vary both effects together in a small design-of-experiments grid (3 x 3 is enough to show an interaction)." : "Sweep the one parameter that matters most (thickness, doping, temperature or bias) to show the trend, not a single point.",
    ] },
  ];
}

function fabPhases(pb) {
  const F = pb.fab, T = pb.tcad;
  return [
    { title: "Check you can build it", tools: F.tools, steps: [
      F.route,
      "Turn the simulated structure into a process flow, step by step, in " + T.tools[0] + ", and mark any step your cleanroom cannot do.",
      "Design short-loop test structures for the one feature that gives the improvement, plus a reference device without it.",
    ] },
    { title: "Fabricate", tools: [], steps: F.steps },
    { title: "Measure", tools: [], steps: F.measure },
    { title: "Compare with the simulation", tools: [], steps: [
      `Measure the same figures of merit the paper simulated (${T.figure}) and plot them on the same axes as the simulation.`,
      "Where silicon and simulation disagree, recalibrate the TCAD deck (traps, interface quality, real dimensions) and explain the difference.",
    ] },
  ];
}

function circuitPhases(pb, cat) {
  const E = cat.eda;
  return [
    { title: "Get device data", tools: [], steps: [
      "Use measured curves if the paper is fabricated; otherwise generate them with TCAD (" + pb.tcad.tools[0] + "): " + pb.tcad.runs.slice(0, 2).join("; ") + ".",
      "Cover the full operating range: every bias, temperature and pulse condition the circuit will use.",
    ] },
    { title: "Build the compact model", tools: E.tools.filter((t) => /OpenVAF|Verilog|ASM|BSIM|Sentaurus|Silvaco/i.test(t)), steps: [
      E.compact_model,
      "Write it in Verilog-A, compile it (Spectre's AHDL or OpenVAF for ngspice and Xyce), and fit the parameters to the device data until the error is under about 5%.",
    ] },
    { title: "Simulate the circuit", tools: E.tools, steps: E.steps },
    { title: "Compare", tools: [], steps: [
      "Run the same circuit with today's standard device as the baseline.",
      "Report the system-level numbers (speed, energy, area, error rate or efficiency) side by side.",
    ] },
  ];
}

const OUTCOME = {
  fab: (pb) => `The first measured demonstration of the device, with ${pb.tcad.figure} compared directly against the published simulation. That is usually a journal paper (IEEE EDL or T-ED) on its own.`,
  tcad: (pb, feat) => feat ? `A quantified answer to how much ${lc(feat.name)} changes ${pb.tcad.figure}, with a calibrated deck others can reuse. That is a conference paper, and a journal paper if you add design guidance.`
    : `A calibrated simulation showing whether the idea improves ${pb.tcad.figure}, and by how much.`,
  circuit: () => "A compact model plus circuit results showing what the device change is worth at system level. Device papers rarely include this, so it is a strong addition and often a separate paper.",
  study: (pb) => `A clear statement of whether the gap is still open, then one of the routes above to close it, judged by ${pb.tcad.figure}.`,
};

const EFFORT = {
  tcad: "About 4 to 8 weeks with a working TCAD licence",
  fab: "About 6 to 12 months, with cleanroom or partner access",
  circuit: "About 4 to 8 weeks, plus device data",
  study: "About 1 to 2 weeks to confirm, then the chosen route",
};

/**
 * The plan for one gap. g: a gap (rule or AI). cat: its field (with playbook and eda).
 * Returns { route, label, effort, phases: [{title, tools, steps}], outcome }.
 */
export function actionPlan(g, cat) {
  const pb = cat && cat.playbook;
  if (!pb) return null;
  const route = routeOf(g);
  const feat = g.feature ? (cat.features || []).find((f) => f.id === g.feature) : null;
  let phases;
  if (route === "fab") phases = fabPhases(pb);
  else if (route === "circuit") phases = circuitPhases(pb, cat);
  else if (route === "tcad") phases = tcadPhases(pb, cat, feat, g);
  else phases = [
    { title: "Confirm the gap is still open", tools: ["Google Scholar", "Semantic Scholar", "this site's citation tree"], steps: [
      "Read the passages behind the gap in the paper itself.",
      "Search the papers that cite it (listed in the tree) and Google Scholar for the same keywords since its publication date.",
      "If nobody has done it, write the gap down in one sentence with the paper that names it. That sentence is your motivation paragraph.",
    ] },
    { title: "Pick the route", tools: [], steps: [
      "Simulation only: follow the TCAD plan (" + pb.tcad.tools[0] + ").",
      "Needs silicon: follow the fabrication plan. " + pb.fab.route,
      "Needs a system view: build a compact model and simulate the circuit (" + (cat.eda.tools[0] || "SPICE") + ").",
    ] },
    ...tcadPhases(pb, cat, null, g).slice(0, 1),
  ];
  return { route, label: ROUTES[route], short: SHORT[route], effort: EFFORT[route], phases, outcome: OUTCOME[route](pb, feat) };
}
