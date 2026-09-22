import type { Profile, User } from "@sgz/shared";
import type { StatsCollector } from "./stats.js";

/** One user's slice of a run. */
export interface UserRun {
  user: User;
  profile: Profile;
  stats: StatsCollector;
}
