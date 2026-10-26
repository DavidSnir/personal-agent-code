export type AppService = {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
};
