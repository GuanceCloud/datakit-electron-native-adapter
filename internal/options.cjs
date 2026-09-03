"use strict";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function requiredString(value, label) {
  const result = optionalString(value, label).trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function rate(value, fallback, label) {
  const normalized = value ?? fallback;
  if (typeof normalized !== "number" || !Number.isFinite(normalized) ||
      normalized < 0 || normalized > 1) {
    throw new Error(`${label} must be a finite number from 0 through 1.`);
  }
  return normalized;
}

function integer(value, fallback, minimum, maximum, label) {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return normalized;
}

function boolean(value, fallback, label) {
  const normalized = value ?? fallback;
  if (typeof normalized !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return normalized;
}

function reportError(onError, error) {
  if (typeof onError === "function") onError(error);
  else console.error("[CloudCare.ElectronNativeAdapter]", error);
}

module.exports = {
  boolean,
  integer,
  optionalString,
  rate,
  reportError,
  requireObject,
  requiredString,
};
