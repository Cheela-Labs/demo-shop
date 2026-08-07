/**
 * The address form, shared by checkout and the account address book so the two
 * cannot drift into accepting different things.
 *
 * Indian shape: state is required and the PIN code is six digits. The `pattern`
 * and `inputMode` attributes make the browser do the first pass — the server
 * validates the same rules again in `repo.validateAddress`, because a client
 * check is a convenience and never a guarantee.
 */

export const BLANK_ADDRESS = {
  label: 'Home',
  name: '',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postcode: '',
  country: 'India',
};

/** The states and union territories a courier will recognise. */
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

/** Address as printed lines, for showing a saved address compactly. */
export function addressLines(a) {
  if (!a) return [];
  return [
    [a.line1, a.line2].filter(Boolean).join(', '),
    [a.city, a.state].filter(Boolean).join(', '),
    [a.postcode, a.country].filter(Boolean).join(' · '),
    a.phone ? `Phone ${a.phone}` : null,
  ].filter(Boolean);
}

export default function AddressForm({ value, onChange, showLabel = true }) {
  const set = (key) => (event) => onChange({ ...value, [key]: event.target.value });

  return (
    <div className="form">
      {showLabel && (
        <div className="row-2">
          <div className="field">
            <label htmlFor="addr-label">Save as</label>
            <input
              id="addr-label" className="input" value={value.label} onChange={set('label')}
              placeholder="Home, Office…" maxLength={24}
            />
          </div>
          <div className="field">
            <label htmlFor="addr-name">Recipient</label>
            <input
              id="addr-name" className="input" value={value.name} onChange={set('name')}
              required autoComplete="name"
            />
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="addr-line1">Flat, house no., building, street</label>
        <input
          id="addr-line1" className="input" value={value.line1} onChange={set('line1')}
          required autoComplete="address-line1" placeholder="221B Turner Road"
        />
      </div>

      <div className="field">
        <label htmlFor="addr-line2">Area, landmark (optional)</label>
        <input
          id="addr-line2" className="input" value={value.line2} onChange={set('line2')}
          autoComplete="address-line2" placeholder="Bandra West"
        />
      </div>

      <div className="row-2">
        <div className="field">
          <label htmlFor="addr-city">City</label>
          <input
            id="addr-city" className="input" value={value.city} onChange={set('city')}
            required autoComplete="address-level2"
          />
        </div>
        <div className="field">
          <label htmlFor="addr-state">State</label>
          <select
            id="addr-state" className="input" value={value.state} onChange={set('state')}
            required autoComplete="address-level1"
          >
            <option value="">Select a state</option>
            {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="row-2">
        <div className="field">
          <label htmlFor="addr-postcode">PIN code</label>
          <input
            id="addr-postcode" className="input" value={value.postcode} onChange={set('postcode')}
            required inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6}
            autoComplete="postal-code" placeholder="400050"
          />
          <span className="hint">Six digits</span>
        </div>
        <div className="field">
          <label htmlFor="addr-phone">Mobile</label>
          <input
            id="addr-phone" className="input" value={value.phone} onChange={set('phone')}
            inputMode="tel" pattern="(\+91)?[6-9][0-9]{9}" maxLength={13}
            autoComplete="tel" placeholder="9876543210"
          />
          <span className="hint">For delivery updates</span>
        </div>
      </div>
    </div>
  );
}
