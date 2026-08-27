-- Macedonia reward and ledger repair
-- Run this once in the Supabase SQL Editor after macedonia_oil_setup.sql.
-- It fixes gift-code and daily-bonus credits so each successful reward produces
-- both its dedicated history row and an idempotent wallet_transactions ledger row.

begin;

insert into public.site_settings(key, value)
values ('daily_checkin_amount', '50')
on conflict (key) do update set value = excluded.value;

-- Preserve auditability for legacy redemptions that already have a confirmed
-- redemption-history row but no corresponding wallet ledger entry. The balance
-- was credited by the legacy API, so this records history only and does not
-- modify the wallet again.
insert into public.wallet_transactions (
  user_id, type, amount, balance_after, description, external_reference, metadata
)
select
  r.user_id,
  'gift_code',
  r.amount,
  null,
  'Gift code redeemed: ' || g.code,
  'gift:' || g.id::text || ':' || r.user_id::text,
  jsonb_build_object('gift_code_id', g.id, 'gift_code', g.code, 'redemption_id', r.id, 'backfilled', true)
from public.gift_code_redemptions r
join public.gift_codes g on g.id = r.gift_code_id
where not exists (
  select 1
  from public.wallet_transactions t
  where t.user_id = r.user_id
    and t.type = 'gift_code'
    and (
      t.external_reference = 'gift:' || g.id::text || ':' || r.user_id::text
      or (t.amount = r.amount and t.description in ('Gift code: ' || g.code, 'Gift code redeemed: ' || g.code))
    )
);

-- The legacy daily-bonus procedure could record a successful zero-value check-in.
-- Repair only the migration-day claim, avoiding speculative credits for earlier
-- days that were intentionally configured at zero.
do $$
declare
  v_checkin record;
  v_wallet public.wallets%rowtype;
  v_amount numeric(18,2) := 50;
begin
  for v_checkin in
    select c.id, c.user_id, c.date
    from public.daily_checkins c
    where c.date = current_date
      and c.amount = 0
      and not exists (
        select 1
        from public.wallet_transactions t
        where t.external_reference = 'checkin:' || c.user_id::text || ':' || c.date::text
      )
    for update
  loop
    insert into public.wallets(user_id)
    values (v_checkin.user_id)
    on conflict (user_id) do nothing;

    select * into v_wallet
    from public.wallets
    where user_id = v_checkin.user_id
    for update;

    update public.daily_checkins
    set amount = v_amount
    where id = v_checkin.id;

    update public.wallets
    set balance = balance + v_amount,
        total_profit = total_profit + v_amount
    where user_id = v_checkin.user_id;

    insert into public.wallet_transactions (
      user_id, type, amount, balance_after, description, external_reference, metadata
    ) values (
      v_checkin.user_id,
      'daily_bonus',
      v_amount,
      v_wallet.balance + v_amount,
      'Daily account check-in bonus',
      'checkin:' || v_checkin.user_id::text || ':' || v_checkin.date::text,
      jsonb_build_object('checkin_id', v_checkin.id, 'date', v_checkin.date, 'backfilled', true)
    ) on conflict (external_reference) do nothing;
  end loop;
end;
$$;

create or replace function public.claim_daily_bonus(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(18,2);
  v_checkin_id uuid;
  v_wallet public.wallets%rowtype;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_amount := coalesce(public.setting_value('daily_checkin_amount', '50')::numeric, 50);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'daily_bonus_disabled');
  end if;

  insert into public.wallets(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_wallet
  from public.wallets
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'wallet_not_found');
  end if;

  insert into public.daily_checkins(user_id, date, amount)
  values (p_user_id, current_date, v_amount)
  on conflict (user_id, date) do nothing
  returning id into v_checkin_id;

  if v_checkin_id is null then
    return jsonb_build_object('ok', false, 'error', 'already_claimed');
  end if;

  update public.wallets
  set balance = balance + v_amount,
      total_profit = total_profit + v_amount
  where user_id = p_user_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    p_user_id,
    'daily_bonus',
    v_amount,
    v_wallet.balance + v_amount,
    'Daily account check-in bonus',
    'checkin:' || p_user_id::text || ':' || current_date::text,
    jsonb_build_object('checkin_id', v_checkin_id, 'date', current_date)
  ) on conflict (external_reference) do nothing;

  return jsonb_build_object('ok', true, 'amount', v_amount, 'checkin_id', v_checkin_id);
end;
$$;

create or replace function public.redeem_gift_code(
  p_user_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_gift public.gift_codes%rowtype;
  v_wallet public.wallets%rowtype;
  v_redemption_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_code = '' then
    return jsonb_build_object('ok', false, 'error', 'code_required');
  end if;

  select * into v_gift
  from public.gift_codes
  where code = v_code
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_gift_code');
  end if;
  if v_gift.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'gift_code_inactive');
  end if;
  if v_gift.expires_at is not null and v_gift.expires_at < timezone('utc', now()) then
    return jsonb_build_object('ok', false, 'error', 'gift_code_expired');
  end if;
  if v_gift.uses >= v_gift.max_uses then
    return jsonb_build_object('ok', false, 'error', 'gift_code_fully_used');
  end if;

  insert into public.wallets(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_wallet
  from public.wallets
  where user_id = p_user_id
  for update;

  insert into public.gift_code_redemptions(gift_code_id, user_id, amount)
  values (v_gift.id, p_user_id, v_gift.amount)
  on conflict (gift_code_id, user_id) do nothing
  returning id into v_redemption_id;

  if v_redemption_id is null then
    return jsonb_build_object('ok', false, 'error', 'gift_code_already_redeemed');
  end if;

  update public.gift_codes
  set uses = uses + 1,
      status = case when uses + 1 >= max_uses then 'used' else status end
  where id = v_gift.id;

  update public.wallets
  set balance = balance + v_gift.amount
  where user_id = p_user_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    p_user_id,
    'gift_code',
    v_gift.amount,
    v_wallet.balance + v_gift.amount,
    'Gift code redeemed: ' || v_gift.code,
    'gift:' || v_gift.id::text || ':' || p_user_id::text,
    jsonb_build_object('gift_code_id', v_gift.id, 'gift_code', v_gift.code, 'redemption_id', v_redemption_id)
  ) on conflict (external_reference) do nothing;

  return jsonb_build_object(
    'ok', true,
    'amount', v_gift.amount,
    'code', v_gift.code,
    'redemption_id', v_redemption_id
  );
end;
$$;

revoke all on function public.claim_daily_bonus(uuid) from public;
revoke all on function public.redeem_gift_code(uuid, text) from public;
grant execute on function public.claim_daily_bonus(uuid) to service_role;
grant execute on function public.redeem_gift_code(uuid, text) to service_role;

commit;
