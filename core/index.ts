/**
 * amux core -- Agent Multiplexer
 *
 * Public API for multi-agent coordination.
 * Pi-independent, framework-agnostic, zero dependencies beyond Node.js.
 */

// Re-export core modules
export * from "./storage";
export * from "./registry";
export * from "./messaging";
export * from "./backlog";
export * from "./reservations";
export * from "./journal";
export * from "./task-comments";
export * from "./project-context";
export * from "./renderers";
export * from "./task-service";
export * from "./task-state-machine";
export * from "./roles";
export * from "./prompt-assembly";
export * from "./notification-service";
export * from "./setup-service";
export * from "./prompt-context";
export * from "./tools/index";
export * from "./ways-of-working";
export * from "./discussions";