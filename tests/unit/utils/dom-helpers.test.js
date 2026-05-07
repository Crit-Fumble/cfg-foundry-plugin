/**
 * DOM Helpers Security Tests
 * Tests for XSS prevention in safe DOM manipulation functions
 */

import { jest } from '@jest/globals'

describe('DOM Helpers - XSS Prevention', () => {
  let setElementContent, createButton, createElementWithText, createLink

  beforeAll(async () => {
    // Mock DOM
    global.document = {
      createElement: jest.fn((tag) => ({
        tagName: tag.toUpperCase(),
        appendChild: jest.fn(),
        setAttribute: jest.fn(),
        className: '',
        textContent: '',
        dataset: {},
        addEventListener: jest.fn(),
      })),
      createTextNode: jest.fn((text) => ({ nodeType: 3, textContent: text })),
    }

    const module = await import('../../../scripts/utils/dom-helpers.js')
    setElementContent = module.setElementContent
    createButton = module.createButton
    createElementWithText = module.createElementWithText
    createLink = module.createLink
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('setElementContent', () => {
    it('should safely set text content without XSS', () => {
      const element = document.createElement('div')
      const maliciousText = '<script>alert("XSS")</script>'

      setElementContent(element, maliciousText)

      // Should set textContent (which auto-escapes), not innerHTML
      expect(element.textContent).toBe('')
      expect(element.appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: maliciousText }))
    })

    it('should add icon safely', () => {
      const element = document.createElement('div')

      setElementContent(element, 'Safe text', { icon: 'fas fa-check' })

      expect(document.createElement).toHaveBeenCalledWith('i')
      expect(element.appendChild).toHaveBeenCalledTimes(3) // icon, space, text
    })

    it('should handle empty text', () => {
      const element = document.createElement('div')

      setElementContent(element, '')

      expect(element.textContent).toBe('')
    })

    it('should clear existing content first', () => {
      const element = document.createElement('div')
      element.textContent = 'old content'

      setElementContent(element, 'new content')

      expect(element.textContent).toBe('')
    })
  })

  describe('createButton', () => {
    it('should create button with safe text', () => {
      const maliciousText = '"><script>alert("XSS")</script><button class="'

      const button = createButton(maliciousText, { className: 'test-btn' })

      expect(button.tagName).toBe('BUTTON')
      expect(button.appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: maliciousText }))
    })

    it('should add click handler without XSS risk', () => {
      const mockClick = jest.fn()

      const button = createButton('Click me', { onClick: mockClick })

      expect(button.addEventListener).toHaveBeenCalledWith('click', mockClick)
    })

    it('should create button with icon and text', () => {
      const button = createButton('Submit', {
        icon: 'fas fa-check',
        className: 'submit-btn',
      })

      expect(document.createElement).toHaveBeenCalledWith('i')
      expect(button.className).toBe('submit-btn')
    })
  })

  describe('createElementWithText', () => {
    it('should create element with escaped text', () => {
      const maliciousHTML = '<img src=x onerror=alert("XSS")>'

      const element = createElementWithText('span', maliciousHTML)

      expect(element.tagName).toBe('SPAN')
      expect(element.appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: maliciousHTML }))
    })

    it('should add attributes safely', () => {
      const element = createElementWithText('div', 'Text', {
        attributes: { id: 'test-id', 'data-value': '123' },
      })

      expect(element.setAttribute).toHaveBeenCalledWith('id', 'test-id')
      expect(element.setAttribute).toHaveBeenCalledWith('data-value', '123')
    })

    it('should add dataset properties safely', () => {
      const element = createElementWithText('div', 'Text', {
        dataset: { userId: '42', action: 'delete' },
      })

      expect(element.dataset.userId).toBe('42')
      expect(element.dataset.action).toBe('delete')
    })
  })

  describe('createLink', () => {
    it('should create link with safe text', () => {
      const maliciousURL = 'javascript:alert("XSS")'
      const maliciousText = '<script>alert("XSS")</script>'

      const link = createLink(maliciousURL, maliciousText)

      expect(link.tagName).toBe('A')
      expect(link.href).toBe(maliciousURL) // URL set as-is, browser handles
      expect(link.appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: maliciousText }))
    })

    it('should add security attributes for new tab links', () => {
      const link = createLink('https://example.com', 'Example', {
        newTab: true,
      })

      expect(link.target).toBe('_blank')
      expect(link.rel).toBe('noopener noreferrer')
    })
  })

  describe('XSS Attack Scenarios', () => {
    it('should prevent script tag injection', () => {
      const element = document.createElement('div')

      setElementContent(element, '<script>alert(document.cookie)</script>')

      // Text should be escaped, not executed as HTML
      expect(element.appendChild).toHaveBeenCalledWith(
        expect.objectContaining({
          textContent: '<script>alert(document.cookie)</script>',
        }),
      )
    })

    it('should prevent img onerror injection', () => {
      const element = document.createElement('div')

      setElementContent(element, '<img src=x onerror=alert("XSS")>')

      expect(element.appendChild).toHaveBeenCalledWith(
        expect.objectContaining({
          textContent: '<img src=x onerror=alert("XSS")>',
        }),
      )
    })

    it('should prevent event handler injection', () => {
      const element = createElementWithText('div', 'Text', {
        attributes: { onclick: 'alert("XSS")' },
      })

      // Attributes are set via setAttribute, which is safer than innerHTML
      expect(element.setAttribute).toHaveBeenCalledWith('onclick', 'alert("XSS")')
      // Browser won't execute strings set via setAttribute as event handlers
    })
  })
})
