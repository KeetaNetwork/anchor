import { createAssert } from 'typia';
import type { Profile, PublicProfile } from './profile.ts';

export const assertProfile: (input: unknown) => Profile = createAssert<Profile>();
export const assertPublicProfile: (input: unknown) => PublicProfile = createAssert<PublicProfile>();
