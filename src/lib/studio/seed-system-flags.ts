import { defaultSystemFlags } from './system-flags';

export interface SystemFlagSeedClient {
  systemFlag: {
    createMany(args: {
      data: Array<{ key: string; value: string }>;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

/**
 * Insert default flags that do not exist yet. `skipDuplicates` means existing rows — including
 * a kill switch an operator has turned on — are left untouched. Returns the number inserted.
 */
export async function seedSystemFlags(client: SystemFlagSeedClient): Promise<number> {
  const { count } = await client.systemFlag.createMany({
    data: [...defaultSystemFlags()],
    skipDuplicates: true,
  });
  return count;
}
