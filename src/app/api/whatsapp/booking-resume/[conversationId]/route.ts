import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

const BOOKING_RESUME_WEBHOOK = 'https://n8n-lxfa.srv1928952.hstgr.cloud/webhook/booking-resume-bot'
type Params = { params: Promise<{ conversationId: string }> }

export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { conversationId } = await params
    const { data: conversation, error } = await supabase.from('conversations').select('contact:contacts(phone)').eq('id', conversationId).eq('account_id', accountId).single()
    if (error || !conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    const contact = conversation.contact as unknown as { phone?: string } | { phone?: string }[] | null
    const rawPhone = Array.isArray(contact) ? contact[0]?.phone : contact?.phone
    const mobile = rawPhone ? sanitizePhoneForMeta(rawPhone) : ''
    if (!mobile) return NextResponse.json({ error: 'Customer phone number not found' }, { status: 400 })
    const response = await fetch(BOOKING_RESUME_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile }), signal: AbortSignal.timeout(5000) })
    if (!response.ok) { console.error('[booking-resume-bot] Webhook returned', response.status, await response.text().catch(() => '')); return NextResponse.json({ error: 'Failed to resume booking bot' }, { status: 502 }) }
    return NextResponse.json({ success: true })
  } catch (error) { console.error('[booking-resume-bot] Error:', error); return toErrorResponse(error) }
}
