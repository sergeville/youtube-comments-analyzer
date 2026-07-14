export const CONTEXT_CLASSIFIER_VERSION = "yca-context-v1";

export const CONTEXT_MODES = Object.freeze([
  "Question",
  "Advice",
  "Experience",
  "Concern",
  "Praise",
  "Request",
  "Problem",
  "Support",
  "Reply",
  "Discussion",
]);

const MODE_SET = new Set(CONTEXT_MODES);

const KNOWN_PROFILES = new Set([
  "ai-tools",
  "generic",
  "homestead-build",
  "municipal-property",
  "unknown",
]);

const CATEGORY_SUBJECTS = new Map(Object.entries({
  "municipal bill or process": "Municipal",
  "legal or appeal advice": "Legal",
  "property or utility issue": "Property",
  "contractor or professional advice": "Contractor",
  "documentation or evidence advice": "Documentation",
  "cost shock or fairness": "Cost",
  "similar personal experience": "Personal",
  "support or empathy": "Community",
  "land clearing or forestry": "Land Clearing",
  "house build or design planning": "House Design",
  "equipment, tools, or repairs": "Equipment",
  "canada and mexico project context": "Project",
  "safety, health, or site risk": "Site Safety",
  "city bill or cost reaction": "City Cost",
  "future content question": "Future Content",
  "audience support or praise": "Audience",
  "pets or family moment": "Family",
  "risk or limitation concern": "Platform Risk",
  "setup troubleshooting": "Setup",
  "future content request": "Future Content",
  "usage testimonial": "Usage",
  "production or design question": "Production",
  "positive feedback": "Feedback",
  "question or help request": "Help",
  "advice or recommendation": "Recommendation",
  "personal experience": "Personal",
  "concern or objection": "Issue",
  "creator promotion": "Creator",
  "creator reply": "Creator",
  "general comment": "General",
  "uncategorized": "General",
}));
const KNOWN_CATEGORIES = new Set(CATEGORY_SUBJECTS.keys());

const SUBJECT_STOPWORDS = new Set([
  "a", "an", "and", "or", "the", "to", "of", "for", "with",
  "comment", "comments", "context", "category",
]);

const INTENT_MODES = new Map(Object.entries({
  question: "Question",
  advice: "Advice",
  experience: "Experience",
  objection: "Concern",
  praise: "Praise",
  request: "Request",
  diagnosis: "Problem",
  support: "Support",
  response: "Reply",
  planning: "Discussion",
  process: "Problem",
  commercial: "Request",
}));

const SENTIMENT_MODES = new Map(Object.entries({
  positive: "Praise",
  concerned: "Concern",
  negative: "Concern",
}));

const TEXT_MODE_RULES = [
  [/\b(?:please|could you|would you|can you make|can you add)\b/, "Request"],
  [/\?|\b(?:how|what|why|where|when|who|does|do you|can i)\b/, "Question"],
  [/\b(?:should|recommend|try|make sure|you need|you could|consider)\b/, "Advice"],
  [/\b(?:problem|error|broken|failed|failure|doesn't work|not working)\b/, "Problem"],
  [/\b(?:risk|unsafe|worried|concern|warning|careful|danger)\b/, "Concern"],
  [/\b(?:i had|i have|i used|in my|we had|we use|happened to me)\b/, "Experience"],
  [/\b(?:sorry|good luck|stay strong|hope this helps|you got this)\b/, "Support"],
  [/\b(?:great|love|thanks|thank you|awesome|amazing|helpful|excellent)\b/, "Praise"],
];

function titleCase(word) {
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function slug(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function normalizedString(value, fallback, field) {
  if (value == null) return fallback;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  return normalized === "" ? fallback : normalized;
}

function keyPart(value, knownValues, fallback, field) {
  const normalized = normalizedString(value, fallback, field).toLowerCase();
  return knownValues.has(normalized) ? slug(normalized) : encodeURIComponent(normalized);
}

export function isValidContextName(name) {
  return typeof name === "string"
    && /^[A-Za-z0-9]+(?: [A-Za-z0-9]+){0,2}$/.test(name);
}

export function deriveContextSubject(category) {
  const normalized = normalizedString(
    category,
    "Uncategorized",
    "evaluation.category",
  ).toLowerCase();
  const known = CATEGORY_SUBJECTS.get(normalized);
  if (known) {
    return known;
  }

  const words = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SUBJECT_STOPWORDS.has(word))
    .slice(0, 2)
    .map(titleCase);
  return words.join(" ") || "General";
}

function modeFromText(text) {
  const value = String(text || "").toLowerCase();
  return TEXT_MODE_RULES.find(([pattern]) => pattern.test(value))?.[1] || null;
}

function modeFromCreator(comment, intent) {
  if (!comment.isCreator) return null;
  return intent === "commercial" ? "Request" : "Reply";
}

function modeFromThread(comment) {
  return comment.parent && comment.parent !== "root" ? "Reply" : null;
}

export function deriveContextMode({ comment = {}, evaluation = {} } = {}) {
  const intent = String(evaluation.intent || "").toLowerCase();
  const sentiment = String(evaluation.sentiment || "").toLowerCase();
  const candidates = [
    modeFromCreator(comment, intent),
    modeFromText(comment.text),
    INTENT_MODES.get(intent),
    SENTIMENT_MODES.get(sentiment),
    modeFromThread(comment),
  ];
  return candidates.find(Boolean) || "Discussion";
}

function assertContextObject(context) {
  if (Object.prototype.toString.call(context) !== "[object Object]") {
    throw new Error("evaluation.context must be an object");
  }
}

function assertControlledMode(context) {
  if (!MODE_SET.has(context.mode)) {
    throw new Error(`evaluation.context.mode must be a controlled mode, received "${context.mode || ""}"`);
  }
}

function assertClassifierVersion(context) {
  if (context.classifierVersion !== CONTEXT_CLASSIFIER_VERSION) {
    throw new Error(
      `evaluation.context.classifierVersion must be "${CONTEXT_CLASSIFIER_VERSION}"`,
    );
  }
}

function assertContextName(context) {
  if (!isValidContextName(context.name)) {
    throw new Error("evaluation.context.name must contain one to three ASCII words");
  }
}

function assertExpectedName(context, category) {
  const expected = `${deriveContextSubject(category)} ${context.mode}`;
  if (context.name !== expected) {
    throw new Error(`evaluation.context.name expected "${expected}" for category "${category}"`);
  }
}

export function validateCommentContext(context, { category = "Uncategorized" } = {}) {
  assertContextObject(context);
  assertControlledMode(context);
  assertClassifierVersion(context);
  assertContextName(context);
  assertExpectedName(context, category);
  return context;
}

export function deriveCommentContext({ comment = {}, evaluation = {} } = {}) {
  const category = normalizedString(
    evaluation.category,
    "Uncategorized",
    "evaluation.category",
  );
  const mode = deriveContextMode({ comment, evaluation });
  const context = {
    name: `${deriveContextSubject(category)} ${mode}`,
    mode,
    classifierVersion: CONTEXT_CLASSIFIER_VERSION,
  };
  return validateCommentContext(context, { category });
}

function evaluationFor(comment) {
  if (comment.evaluation === undefined) return {};
  if (Object.prototype.toString.call(comment.evaluation) === "[object Object]") {
    return comment.evaluation;
  }
  throw new Error("evaluation must be an object");
}

export function resolveCommentContext(comment = {}) {
  const evaluation = evaluationFor(comment);
  if (evaluation.context === undefined) {
    return deriveCommentContext({ comment, evaluation });
  }
  return validateCommentContext(evaluation.context, {
    category: evaluation.category || "Uncategorized",
  });
}

export function buildContextKey(profile, category, context) {
  const normalizedCategory = normalizedString(
    category,
    "Uncategorized",
    "evaluation.category",
  );
  return [
    context.classifierVersion,
    keyPart(profile, KNOWN_PROFILES, "unknown", "classification.profile"),
    keyPart(
      normalizedCategory,
      KNOWN_CATEGORIES,
      "Uncategorized",
      "evaluation.category",
    ),
    slug(context.name),
  ].join("|");
}
