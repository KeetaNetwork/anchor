import { createAssert } from 'typia';
import type { Profile, PublicProfile, PrivateProfile } from './profile.ts';

export const assertProfile: (input: unknown) => Profile = createAssert<Profile>();
export const assertPublicProfile: (input: unknown) => PublicProfile = createAssert<PublicProfile>();
export const assertPrivateProfile: (input: unknown) => PrivateProfile = createAssert<PrivateProfile>();
