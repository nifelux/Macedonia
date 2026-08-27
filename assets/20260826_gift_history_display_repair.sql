-- Macedonia gift-redemption history display repair
-- Run this once in the Supabase SQL Editor after the reward-ledger repair.

begin;

-- A user may read only the code associated with that user's own confirmed
-- redemption. This allows the existing relational history query to render the
-- redeemed code without exposing active, inactive, or unredeemed gift codes.
drop policy if exists gift_codes_redeemer_select on public.gift_codes;
create policy gift_codes_redeemer_select on public.gift_codes for select to authenticated
using (
  exists (
    select 1
    from public.gift_code_redemptions r
    where r.gift_code_id = gift_codes.id
      and r.user_id = auth.uid()
  )
);

grant select (id, code) on public.gift_codes to authenticated;

commit;
