export const ADMIN_ROLES = Object.freeze([
  'owner',
  'admin',
  'finance',
  'compliance',
  'support',
]);

export function isAuthorizedAdminClaims(claims) {
  return claims?.admin === true && ADMIN_ROLES.includes(claims?.role);
}
