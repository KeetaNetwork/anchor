import { createAssert } from 'typia';
import type { Contact } from './contacts.ts';

export const assertContact: (input: unknown) => Contact = createAssert<Contact>();
