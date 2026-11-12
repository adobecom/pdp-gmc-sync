import React from 'react'
import { StatusLight } from '@adobe/react-spectrum'
import { STATUS } from '../format'

export default function StatusChip ({ status }) {
  const s = STATUS[status] || { variant: 'neutral', label: status || 'Unknown' }
  return <StatusLight variant={s.variant}>{s.label}</StatusLight>
}
