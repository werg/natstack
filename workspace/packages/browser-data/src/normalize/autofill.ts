/**
 * Normalize autofill field names to canonical forms.
 * Different browsers may use different names for the same field.
 */
const FIELD_NAME_MAP: Record<string, string> = {
  "email": "email",
  "e-mail": "email",
  "emailaddress": "email",
  "email-address": "email",
  "firstname": "given-name",
  "first-name": "given-name",
  "given_name": "given-name",
  "givenname": "given-name",
  "lastname": "family-name",
  "last-name": "family-name",
  "family_name": "family-name",
  "familyname": "family-name",
  "phone": "tel",
  "telephone": "tel",
  "phonenumber": "tel",
  "phone-number": "tel",
  "zipcode": "postal-code",
  "zip-code": "postal-code",
  "zip": "postal-code",
  "postalcode": "postal-code",
};

export function normalizeFieldName(name: string): string {
  const lower = name.toLowerCase().trim();
  return FIELD_NAME_MAP[lower] || lower;
}
