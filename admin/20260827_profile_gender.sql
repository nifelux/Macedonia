-- Macedonia profile gender extension
-- Run once in the Supabase SQL Editor for an existing Macedonia database.
-- This does not alter existing user records; their gender remains null until supplied.

begin;

alter table public.profiles
  add column if not exists gender text;

alter table public.profiles
  drop constraint if exists profiles_gender_check;

alter table public.profiles
  add constraint profiles_gender_check
  check (gender is null or gender in ('female', 'male', 'prefer_not_to_say'));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral_input text;
  v_referrer_id uuid;
  v_welcome_enabled boolean;
  v_welcome_amount numeric(18,2);
begin
  v_referral_input := upper(trim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')));
  if v_referral_input <> '' then
    select id into v_referrer_id
    from public.profiles
    where referral_code = v_referral_input and is_active = true;
  end if;

  insert into public.profiles (
    id, email, full_name, phone, gender, referral_code, referred_by
  ) values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    nullif(new.raw_user_meta_data ->> 'gender', ''),
    public.generate_referral_code(),
    v_referrer_id
  ) on conflict (id) do nothing;

  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  select coalesce(value = 'true', false) into v_welcome_enabled
  from public.site_settings where key = 'welcome_bonus_enabled';
  select coalesce(nullif(value, '')::numeric, 0) into v_welcome_amount
  from public.site_settings where key = 'welcome_bonus_amount';

  if coalesce(v_welcome_enabled, false) and coalesce(v_welcome_amount, 0) > 0 then
    update public.wallets
    set balance = balance + v_welcome_amount,
        total_profit = total_profit + v_welcome_amount
    where user_id = new.id;

    insert into public.wallet_transactions (
      user_id, type, amount, description, external_reference
    ) values (
      new.id, 'welcome_bonus', v_welcome_amount, 'Account welcome bonus', 'welcome:' || new.id::text
    ) on conflict (external_reference) do nothing;
  end if;

  return new;
end;
$$;

commit;
