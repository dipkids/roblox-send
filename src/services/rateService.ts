import { prisma } from "../database/prisma.js";

const RATE_KEY = "robux_rate";
const DEFAULT_RATE = 160;

export async function getRobuxRate(): Promise<number> {
  const setting = await prisma.systemSetting.findUnique({
    where: {
      key: RATE_KEY,
    },
  });

  if (!setting) {
    const created = await prisma.systemSetting.create({
      data: {
        key: RATE_KEY,
        value: DEFAULT_RATE.toString(),
      },
    });

    return Number(created.value);
  }

  return Number(setting.value);
}

export async function setRobuxRate(
  rate: number,
): Promise<number> {
  const setting = await prisma.systemSetting.upsert({
    where: {
      key: RATE_KEY,
    },
    update: {
      value: rate.toString(),
    },
    create: {
      key: RATE_KEY,
      value: rate.toString(),
    },
  });

  return Number(setting.value);
}

export function calculateRobuxPrice(
  rate: number,
  robuxAmount: number,
): number {
  return rate * robuxAmount;
}