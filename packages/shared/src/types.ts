import type { z } from 'zod';
import type {
  PairingPayloadSchema,
  FsEntrySchema,
  FsResponseSchema,
  ToolInfoSchema,
  ToolsResponseSchema,
  HealthResponseSchema,
  PtyHelloQuerySchema,
  SessionInfoSchema,
  SessionsResponseSchema,
  SettingsResponseSchema,
  SettingsUpdateSchema,
  SettingsUpdateResponseSchema,
  SessionUpdateSchema,
} from './schemas.js';

export type PairingPayload = z.infer<typeof PairingPayloadSchema>;
export type FsEntry = z.infer<typeof FsEntrySchema>;
export type FsResponse = z.infer<typeof FsResponseSchema>;
export type ToolInfo = z.infer<typeof ToolInfoSchema>;
export type ToolsResponse = z.infer<typeof ToolsResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type PtyHelloQuery = z.infer<typeof PtyHelloQuerySchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
export type SettingsUpdateResponse = z.infer<typeof SettingsUpdateResponseSchema>;
export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;
